# vercel-env-pull

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org)

> Export 100% of Vercel environment variables—including write-only **Sensitive** secrets—directly to a local `.env` file with zero downtime and zero domain conflicts.

---

## The Problem

Vercel treats variables flagged as **"Sensitive" (Secret)** as write-only. Once set:
- Standard CLI `vercel env pull` replaces their values with `"[SENSITIVE]"`.
- `vercel env run` strips them or leaves them empty.
- The Vercel REST API (`/v10/projects/:id/env`) zeroes out their values (`"value": ""`).
- The Vercel Dashboard masks them with no reveal button.

If you lose your local `.env` file, Vercel gives you no built-in way to export or view your own sensitive environment variables.

---

## The Solution

While Vercel prevents CLI and API inspection of sensitive variables, Vercel **must** decrypt and inject them into `process.env` when executing serverless functions on its infrastructure.

`vercel-env-pull` automates a safe, ephemeral runtime extraction pipeline:
1. **Zero Downtime & Domain Safety**: Deploys an isolated micro-serverless function with `--skip-domain` and `--target=<environment>`.
   - `--skip-domain` **guarantees no live production domains or aliases are altered or routed**.
   - `--target=production` securely decrypts and injects production secrets.
   - The endpoint is secured with a one-time 48-character cryptographic token (`EXTRACT_SECRET_TOKEN`).
2. **SSO / Deployment Protection Support**: Automatically manages Vercel Deployment Protection if active on the project.
3. **Decryption & Formatting**: Queries the micro-function, pulls `process.env`, filters out AWS Lambda/Vercel runtime variables, formats multiline keys (RSA keys, certificates, JSON configs), and writes them to your target `.env` file.
4. **Immediate Teardown**: Instantly deletes the temporary deployment from Vercel and cleans up local temporary files. Zero trace is left on your Vercel project.

---

## Installation

### Run without installation (recommended)
```bash
npx vercel-env-pull [options]
```

### Install globally
```bash
npm install -g vercel-env-pull
```

### Or clone and run directly
```bash
git clone https://github.com/Ganamedee/vercel-env-pull.git
cd vercel-env-pull
node index.js [options]
```

> **Prerequisite:** Make sure you have the [Vercel CLI](https://vercel.com/docs/cli) installed and logged in (`vercel login`).

---

## Usage

### Quick Start

If you are inside a directory linked to a Vercel project:
```bash
vercel-env-pull
```
This automatically detects the linked project and exports production environment variables to `.env.local`.

### Export from a specific project
```bash
vercel-env-pull --project my-project --output .env.production.local
```

### Export Preview or Development environment
```bash
# Preview environment
vercel-env-pull --project my-project -e preview -o .env.preview.local

# Development environment
vercel-env-pull --project my-project -e development -o .env.development.local
```

---

## CLI Options

| Flag | Shorthand | Description | Default |
|---|---|---|---|
| `--project <name>` | `-p` | Vercel project name or ID | Auto-detected from directory / linked project |
| `--environment <target>` | `-e` | Target environment (`production`, `preview`, `development`) | `production` |
| `--output <file>` | `-o` | Output file path | `.env.local` or `.env.<env>.local` |
| `--scope <team>` | `-s` | Vercel team or user scope | Default scope |
| `--include-system` | | Include Vercel & AWS Lambda runtime system variables | `false` (clean user vars only) |
| `--force-workaround` | | Skip standard pull check and immediately run runtime extraction | `false` |
| `--keep-temp` | | Do not delete the temporary extraction deployment on Vercel | `false` (clean deletion) |
| `--help` | `-h` | Display help and usage message | |

---

## How It Works (Step-by-Step)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Inspect Vercel Project Configuration                     │
│    • Query Vercel API for declared environment variable keys│
│    • Detect if [SENSITIVE] variables exist                  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Create Ephemeral Micro-Serverless Function               │
│    • vercel.json ({"framework": null} - zero build overhead)│
│    • api/extract.js (protected with cryptographic token)    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Deploy to Vercel                                         │
│    • --skip-domain: Zero routing changes to production      │
│    • --target=production: Injects all decrypted secrets     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Retrieve & Filter Variables                              │
│    • Fetch process.env from the micro-deployment endpoint   │
│    • Filter out internal AWS Lambda / Vercel clutter        │
│    • Properly escape multiline secrets & quotes             │
│    • Save to target .env file                               │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Immediate Teardown                                       │
│    • DELETE temporary deployment via Vercel API             │
│    • Purge local temporary directory                        │
│    • Restore project settings (if SSO was active)           │
└─────────────────────────────────────────────────────────────┘
```

---

## Safety Guarantee

- **No Domain Alterations**: The micro-function is deployed using Vercel's `--skip-domain` flag. Production domains and traffic are never aliased or diverted.
- **Secure Token Access**: The extraction endpoint responds only to requests bearing the 48-character secret generated on each run.
- **Clean Teardown**: The deployment is deleted via the Vercel API as soon as the variables are read, so it does not count towards persistent deployment limits.

---

## License

[MIT](LICENSE) © Daniel Tolenaar
