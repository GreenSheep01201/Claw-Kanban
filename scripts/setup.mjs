#!/usr/bin/env node

/**
 * claw-kanban setup script
 *
 * Prepends kanban orchestration rules to the user's AGENTS.md.
 * This is an UPDATE, not an OVERWRITE - existing content is preserved.
 *
 * Usage:
 *   node scripts/setup.mjs [--agents-path /path/to/AGENTS.md]
 *   pnpm setup [-- --agents-path /path/to/AGENTS.md]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "AGENTS-kanban.md");
const START_MARKER = "<!-- BEGIN claw-kanban orchestration rules -->";
const END_MARKER = "<!-- END claw-kanban orchestration rules -->";

function resolveWorkspaceDir() {
  // Try reading workspace from openclaw.json
  const openclawJson = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (fs.existsSync(openclawJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawJson, "utf8"));
      const w = cfg?.agents?.defaults?.workspace?.trim();
      if (w) {
        const resolved = w.replace(/^~/, os.homedir());
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch { /* ignore */ }
  }

  // Check OPENCLAW_PROFILE
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    const profdir = path.join(os.homedir(), ".openclaw", `workspace-${profile}`);
    if (fs.existsSync(profdir)) return profdir;
  }

  return path.join(os.homedir(), ".openclaw", "workspace");
}

function findAgentsPath() {
  // Check CLI args
  const args = process.argv.slice(2);
  const agentsIdx = args.indexOf("--agents-path");
  if (agentsIdx !== -1 && args[agentsIdx + 1]) {
    return path.resolve(args[agentsIdx + 1]);
  }

  // Detect workspace directory using openclaw config
  const workspaceDir = resolveWorkspaceDir();

  // Check common locations
  const candidates = [
    // OpenClaw workspace (detected)
    path.join(workspaceDir, "AGENTS.md"),
    // Current directory
    path.join(process.cwd(), "AGENTS.md"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default: create in detected workspace
  return path.join(workspaceDir, "AGENTS.md");
}

function main() {
  const agentsPath = findAgentsPath();
  const templateContent = fs.readFileSync(TEMPLATE_PATH, "utf8");

  console.log(`[claw-kanban] Setting up kanban orchestration rules`);
  console.log(`[claw-kanban] Target: ${agentsPath}`);

  // Read existing content
  let existingContent = "";
  if (fs.existsSync(agentsPath)) {
    existingContent = fs.readFileSync(agentsPath, "utf8");
  }

  // Check if already installed
  if (existingContent.includes(END_MARKER)) {
    console.log(`[claw-kanban] Kanban rules already present in ${agentsPath}`);
    console.log(`[claw-kanban] To update, remove the section between "${START_MARKER}" and "${END_MARKER}" first.`);
    return;
  }

  // Prepend template to existing content
  const newContent = templateContent + "\n\n" + existingContent;

  // Ensure parent directory exists
  const dir = path.dirname(agentsPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(agentsPath, newContent, "utf8");
  console.log(`[claw-kanban] Kanban orchestration rules added to top of ${agentsPath}`);
  console.log(`[claw-kanban] Your existing AGENTS.md content is preserved below the kanban rules.`);
  console.log(`[claw-kanban] Done!`);
}

main();
