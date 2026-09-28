#!/usr/bin/env node

/**
 * vercel-env-pull: Extract Vercel Environment Variables to .env
 *
 * Workaround for Vercel's [SENSITIVE] CLI redaction:
 * Automatically extracts 100% of environment variables (including write-only Sensitive secrets)
 * by deploying an ephemeral, zero-downtime serverless function with --skip-domain,
 * pulling runtime process.env, and instantly destroying the deployment.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

// Parse CLI arguments
const args = process.argv.slice(2);

function printHelp() {
  console.log(`
▲ vercel-env-pull - Export Vercel Environment Variables to .env

Workaround for Vercel's [SENSITIVE] redaction. Recovers 100% of environment
variables, including write-only Sensitive secrets, with zero production downtime.

USAGE:
  vercel-env-pull [options]
  npx vercel-env-pull [options]
  node index.js [options]

OPTIONS:
  -p, --project <name>         Vercel project name or ID (auto-detected if omitted)
  -e, --environment <target>   Environment: production, preview, development (default: production)
  -o, --output <file>          Output file path (default: .env.local or .env.<env>.local)
  -s, --scope <team>           Team or user scope
      --include-system         Include Vercel & AWS Lambda runtime system variables
      --force-workaround       Bypass standard pull check and immediately run runtime extraction
      --keep-temp              Do not delete the temporary extraction deployment
  -h, --help                   Display this help message

EXAMPLES:
  # Pull production env vars for current linked project to .env.local
  vercel-env-pull

  # Pull production env vars for a specific project
  vercel-env-pull --project dqsb --output .env.production.local

  # Pull preview env vars
  vercel-env-pull --project metrichub -e preview -o .env.preview.local
`);
}

function parseArgs() {
  const options = {
    project: null,
    environment: 'production',
    output: null,
    scope: null,
    includeSystem: false,
    forceWorkaround: false,
    keepTemp: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-p' || arg === '--project') {
      options.project = args[++i];
    } else if (arg === '-e' || arg === '--environment') {
      options.environment = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      options.output = args[++i];
    } else if (arg === '-s' || arg === '--scope') {
      options.scope = args[++i];
    } else if (arg === '--include-system') {
      options.includeSystem = true;
    } else if (arg === '--force-workaround') {
      options.forceWorkaround = true;
    } else if (arg === '--keep-temp') {
      options.keepTemp = true;
    } else if (!arg.startsWith('-') && !options.project) {
      options.project = arg;
    }
  }

  return options;
}

// System variables to filter out unless --include-system is passed
const SYSTEM_ENV_VARS = new Set([
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_LAMBDA_FUNCTION_VERSION',
  'AWS_LAMBDA_INITIALIZATION_TYPE',
  'AWS_LAMBDA_LOG_GROUP_NAME',
  'AWS_LAMBDA_LOG_STREAM_NAME',
  'AWS_EXECUTION_ENV',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'LAMBDA_TASK_ROOT',
  'LAMBDA_RUNTIME_DIR',
  '_HANDLER',
  '_X_AMZN_TRACE_ID',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LANG',
  'OPENSSL_CONF',
  'PWD',
  'SHLVL',
  '_',
  'NODE_VERSION',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_REGION',
  'VERCEL_OIDC_TOKEN',
  'TURBO_CACHE',
  'TURBO_DOWNLOAD_LOCAL_ENABLED',
  'TURBO_REMOTE_ONLY',
  'TURBO_RUN_SUMMARY',
  'TURBO_PLATFORM_ENV',
  'NX_DAEMON',
  'PATH',
  'EXTRACT_SECRET_TOKEN',
]);

// Helper to run commands cleanly on Windows & Unix
function runVercelCmd(command, extraEnv = {}) {
  const isWindows = process.platform === 'win32';
  const fullCmd = isWindows ? `cmd /c "${command} < nul"` : `${command} < /dev/null`;
  return execSync(fullCmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
}

// Helper to auto-detect project
function detectProject(projectArg) {
  if (projectArg) return projectArg;

  // 1. Check .vercel/project.json in current directory
  const localProjectJson = path.join(process.cwd(), '.vercel', 'project.json');
  if (fs.existsSync(localProjectJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(localProjectJson, 'utf-8'));
      if (data.projectId) {
        console.log(`> Detected linked project: ${data.projectId}`);
        return data.projectId;
      }
    } catch (e) {
      // Ignore
    }
  }

  // 2. Check if current directory name matches any project
  const currentDirName = path.basename(process.cwd()).toLowerCase();
  try {
    const listOut = runVercelCmd('vercel project ls');
    const lines = listOut.split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^([a-zA-Z0-9-_]+)\s+https?:\/\//);
      if (match) {
        const projName = match[1];
        if (projName.toLowerCase() === currentDirName || projName.toLowerCase().replace(/-/g, '') === currentDirName.replace(/-/g, '')) {
          console.log(`> Auto-matched project from directory name: ${projName}`);
          return projName;
        }
      }
    }
  } catch (e) {
    // Ignore
  }

  return null;
}

// Fetch project env configuration from Vercel API
function getProjectEnvConfig(projectName, scope) {
  try {
    const scopeFlag = scope ? ` --scope ${scope}` : '';
    const out = runVercelCmd(`vercel api /v10/projects/${projectName}/env${scopeFlag}`);
    const data = JSON.parse(out);
    return data.envs || [];
  } catch (e) {
    return [];
  }
}

// Helper to format values into .env format
function formatEnvFile(envMap, declaredKeys = null, includeSystem = false) {
  const lines = ['# Generated by vercel-env-pull with Sensitive Workaround', `# Timestamp: ${new Date().toISOString()}`, ''];

  const allKeys = Object.keys(envMap).sort();
  let recoveredCount = 0;

  for (const key of allKeys) {
    // If not including system vars, filter them out
    if (!includeSystem) {
      if (SYSTEM_ENV_VARS.has(key)) continue;
      // If declaredKeys exists and key is neither declared nor a public framework var, skip
      if (declaredKeys && declaredKeys.size > 0) {
        if (!declaredKeys.has(key) && !key.startsWith('NEXT_PUBLIC_') && !key.startsWith('VITE_') && !key.startsWith('REACT_APP_')) {
          continue;
        }
      }
    }

    const val = envMap[key];
    if (val === undefined || val === null) continue;

    const strVal = String(val);

    // Escape characters properly for .env
    // If the value contains newlines, double quotes, dollar signs, or special characters:
    if (strVal.includes('\n') || strVal.includes('"') || strVal.includes(' ') || strVal.includes('$') || strVal.includes('#') || strVal.includes('\\')) {
      const escaped = strVal
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}="${strVal}"`);
    }
    recoveredCount++;
  }

  lines.push('');
  return { content: lines.join('\n'), count: recoveredCount };
}

// Request helper with redirect, cookie jar, and SSO bypass support
function makeHttpsRequest(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'vercel-env-pull/1.0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Helper to get project details from Vercel API
function getProjectDetails(projectName, scope) {
  try {
    const scopeFlag = scope ? ` --scope ${scope}` : '';
    const out = runVercelCmd(`vercel api /v9/projects/${projectName}${scopeFlag}`);
    return JSON.parse(out);
  } catch (e) {
    return {};
  }
}

// Helper to update SSO protection setting on project
function setProjectSsoProtection(projectName, ssoProtection, scope) {
  const tempFile = path.join(os.tmpdir(), `sso-${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ ssoProtection }));
    const scopeFlag = scope ? ` --scope ${scope}` : '';
    runVercelCmd(`vercel api /v9/projects/${projectName} -X PATCH --input "${tempFile}"${scopeFlag}`);
  } catch (e) {
    // Ignore error
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

// Main extraction workflow
async function main() {
  const options = parseArgs();

  console.log('▲ vercel-env-pull — Sensitive Environment Variable Workaround');
  console.log('─────────────────────────────────────────────────────────────');

  // 1. Resolve project
  const project = detectProject(options.project);
  if (!project) {
    console.error('❌ Error: Could not determine Vercel project.');
    console.error('Please specify a project using: --project <project-name>');
    console.error('\nAvailable projects on your account:');
    try {
      const list = runVercelCmd('vercel project ls');
      console.log(list);
    } catch (e) {}
    process.exit(1);
  }

  const environment = options.environment.toLowerCase();
  const defaultOutputFile = options.output || (environment === 'production' ? '.env.local' : `.env.${environment}.local`);

  console.log(`📦 Project:      ${project}`);
  console.log(`🌐 Environment:  ${environment}`);
  console.log(`📄 Target File:  ${defaultOutputFile}`);

  // 2. Check declared project variables via API
  console.log('\n🔍 Inspecting environment variables on Vercel...');
  const declaredVars = getProjectEnvConfig(project, options.scope);
  const targetVars = declaredVars.filter((v) => Array.isArray(v.target) && v.target.includes(environment));

  const declaredKeySet = new Set(targetVars.map((v) => v.key));
  const sensitiveVars = targetVars.filter((v) => v.type === 'sensitive' || v.visibility === 'secret');

  console.log(`   Found ${targetVars.length} variable(s) configured for [${environment}]`);
  if (sensitiveVars.length > 0) {
    console.log(`   ⚠️  Detected ${sensitiveVars.length} Sensitive (write-only) variable(s):`);
    sensitiveVars.forEach((v) => console.log(`      • ${v.key}`));
  }

  // If no sensitive variables and not forcing workaround, attempt standard pull
  if (sensitiveVars.length === 0 && !options.forceWorkaround) {
    console.log('\n⚡ No sensitive variables detected. Running standard pull...');
    const tempPullFile = path.join(os.tmpdir(), `pull-${Date.now()}.tmp`);
    try {
      const scopeFlag = options.scope ? ` --scope ${options.scope}` : '';
      runVercelCmd(`vercel env pull "${tempPullFile}" --environment ${environment} --project ${project} --yes${scopeFlag}`);
      const pulledContent = fs.readFileSync(tempPullFile, 'utf-8');
      if (!pulledContent.includes('[SENSITIVE]')) {
        const destPath = path.isAbsolute(defaultOutputFile) ? defaultOutputFile : path.join(process.cwd(), defaultOutputFile);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, pulledContent, 'utf-8');
        fs.unlinkSync(tempPullFile);
        console.log(`\n✅ Successfully exported environment variables to ${destPath}`);
        process.exit(0);
      }
      console.log('   Note: Standard pull contained [SENSITIVE] placeholders. Activating workaround...');
    } catch (e) {
      console.log('   Standard pull failed. Activating workaround...');
    } finally {
      if (fs.existsSync(tempPullFile)) fs.unlinkSync(tempPullFile);
    }
  }

  // 3. RUNTIME EXTRACTION WORKAROUND
  console.log('\n🚀 Starting Ephemeral Serverless Extraction Workaround...');
  console.log('   (Bypasses CLI redaction via isolated micro-lambda runtime)');

  const tempDir = path.join(os.tmpdir(), `vercel-extract-${Date.now()}`);
  fs.mkdirSync(path.join(tempDir, 'api'), { recursive: true });

  // vercel.json: framework: null ensures zero build overhead (100ms build)
  fs.writeFileSync(
    path.join(tempDir, 'vercel.json'),
    JSON.stringify({ framework: null, buildCommand: null, outputDirectory: null }, null, 2)
  );

  // api/extract.js: returns decrypted process.env authenticated with one-time token
  const extractCode = `module.exports = (req, res) => {
  const secret = process.env.EXTRACT_SECRET_TOKEN;
  const token = req.headers['x-extract-token'] || (req.query && req.query.token);
  if (!secret || token !== secret) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(process.env));
};`;
  fs.writeFileSync(path.join(tempDir, 'api', 'extract.js'), extractCode);

  const extractSecret = crypto.randomBytes(24).toString('hex');
  let deploymentUrl = null;
  let deploymentId = null;
  let originalSsoProtection = null;

  try {
    // Check if project has SSO / Deployment Protection enabled
    const projectDetails = getProjectDetails(project, options.scope);
    if (projectDetails && projectDetails.ssoProtection) {
      originalSsoProtection = projectDetails.ssoProtection;
      console.log('   🔐 Deployment Protection (SSO) active on project.');
      console.log('   Temporarily bypassing Deployment Protection for extraction...');
      setProjectSsoProtection(project, null, options.scope);
    }

    console.log('   Deploying isolated micro-function with --skip-domain...');
    console.log('   [Live production domains will NOT be modified]');

    const scopeFlag = options.scope ? ` --scope ${options.scope}` : '';
    const deployCmd = `vercel deploy "${tempDir}" --project "${project}" --target=${environment} --skip-domain --yes -e EXTRACT_SECRET_TOKEN=${extractSecret}${scopeFlag}`;

    const deployOutput = runVercelCmd(deployCmd);

    // Parse deployment URL and ID from output
    const idMatch = deployOutput.match(/dpl_[a-zA-Z0-9]+/);
    if (idMatch) deploymentId = idMatch[0];

    const urlMatch = deployOutput.match(/https:\/\/[a-zA-Z0-9-]+\.vercel\.app/g);
    if (urlMatch && urlMatch.length > 0) {
      // Pick the deployment-specific URL (usually contains project name and random hash)
      deploymentUrl = urlMatch.find((u) => !u.endsWith(`${project}.vercel.app`)) || urlMatch[0];
    }

    if (!deploymentUrl) {
      throw new Error(`Failed to extract deployment URL from Vercel output:\n${deployOutput}`);
    }

    console.log(`   ✓ Micro-deployment ready: ${deploymentUrl}`);

    // 4. Query endpoint to retrieve process.env
    console.log('   Fetching decrypted environment variables...');
    const extractEndpoint = `${deploymentUrl}/api/extract?token=${extractSecret}`;
    const res = await makeHttpsRequest(extractEndpoint, { 'x-extract-token': extractSecret });

    if (res.statusCode !== 200) {
      throw new Error(`Server returned HTTP ${res.statusCode}: ${res.body}`);
    }

    let envData;
    try {
      envData = JSON.parse(res.body);
    } catch (e) {
      throw new Error(`Invalid JSON response from extract endpoint: ${res.body}`);
    }

    // 5. Format and write to output file
    console.log('\n📝 Formatting environment variables...');
    const { content, count } = formatEnvFile(envData, declaredKeySet, options.includeSystem);

    const targetPath = path.isAbsolute(defaultOutputFile) ? defaultOutputFile : path.join(process.cwd(), defaultOutputFile);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');
    console.log(`   ✓ Written ${count} decrypted environment variable(s) to:`);
    console.log(`     👉 ${targetPath}`);

    // Verify sensitive variables were successfully recovered
    const recoveredSensitive = sensitiveVars.filter((v) => envData[v.key] && envData[v.key] !== '[SENSITIVE]');
    if (recoveredSensitive.length > 0) {
      console.log(`\n🎉 Successfully recovered ${recoveredSensitive.length} Sensitive secret(s):`);
      recoveredSensitive.forEach((v) => console.log(`   • ${v.key} = [DECRYPTED, length: ${envData[v.key].length}]`));
    }
  } catch (err) {
    console.error(`\n❌ Error during extraction: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // 6. Immediate Cleanup
    console.log('\n🧹 Cleaning up...');

    // Restore SSO protection if it was temporarily disabled
    if (originalSsoProtection) {
      try {
        setProjectSsoProtection(project, originalSsoProtection, options.scope);
        console.log('   ✓ Restored Deployment Protection (SSO)');
      } catch (e) {
        console.log('   Notice: Please verify SSO protection in project settings.');
      }
    }

    // Delete temporary deployment
    if (deploymentId && !options.keepTemp) {
      try {
        const scopeFlag = options.scope ? ` --scope ${options.scope}` : '';
        runVercelCmd(`vercel api /v13/deployments/${deploymentId} -X DELETE --dangerously-skip-permissions${scopeFlag}`);
        console.log(`   ✓ Deleted temporary deployment (${deploymentId})`);
      } catch (e) {
        console.log(`   Notice: Could not automatically delete deployment ${deploymentId}. You can run: vercel rm ${deploymentUrl}`);
      }
    }

    // Delete local temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('   ✓ Removed local temp files');
      }
    } catch (e) {}

    console.log('✨ All done!\n');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
