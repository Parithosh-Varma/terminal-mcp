/**
 * Environment scrubbing.
 *
 * Commands run inside the sandbox still inherit the server's environment, which
 * is how a CLOUDFLARE_API_TOKEN (or an AWS key, a GitHub token, an SSH agent)
 * ends up readable by whatever the model decides to run. The kernel sandbox
 * protects credential *files*; this protects credential *variables*.
 *
 * Names are matched, never values. Anything that looks like a secret is dropped
 * before the child process starts. Opt specific names back in with
 * TERMINAL_MCP_PASS_ENV=NAME1,NAME2 when a tool genuinely needs one.
 */

const SECRET_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "APIKEY",
  "API_KEY",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "AUTH",
  "COOKIE",
  "SESSION_ID",
  "SIGNATURE",
];

const SECRET_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_",
  "OPENAI_",
  "ANTHROPIC_",
  "CLOUDFLARE_",
  "CF_",
  "GITHUB_",
  "GH_",
  "GITLAB_",
  "NPM_",
  "PYPI_",
  "DOCKER_",
  "STRIPE_",
  "SLACK_",
  "DISCORD_",
  "TELEGRAM_",
  "SUPABASE_",
  "FIREBASE_",
  "VERCEL_",
  "NETLIFY_",
  "HEROKU_",
  "HF_",
  "HUGGINGFACE_",
  "REPLICATE_",
  "COHERE_",
  "MISTRAL_",
  "GROQ_",
  "XAI_",
  "TERMINAL_MCP_",
];

export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return SECRET_SUBSTRINGS.some((needle) => upper.includes(needle));
}

export interface ScrubbedEnv {
  env: NodeJS.ProcessEnv;
  /** Names withheld from the child (never the values). */
  removed: string[];
  /** Names explicitly allowed through TERMINAL_MCP_PASS_ENV. */
  allowed: string[];
}

export function scrubEnv(source: NodeJS.ProcessEnv = process.env): ScrubbedEnv {
  const pass = new Set(
    (source.TERMINAL_MCP_PASS_ENV ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  const allowed: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (pass.has(name)) {
      env[name] = value;
      allowed.push(name);
      continue;
    }
    if (isSecretName(name)) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }

  return { env, removed, allowed };
}
