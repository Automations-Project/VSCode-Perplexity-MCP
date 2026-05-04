import type React from "react";
import amazonQLogo from "../../../mcp-tool-icons/amazon-q.svg?raw";
import ampLogo from "../../../mcp-tool-icons/amp.svg?raw";
import antigravityLogo from "../../../mcp-tool-icons/antigravity.svg?raw";
import claudeCodeLogo from "../../../mcp-tool-icons/claude-code.svg?raw";
import claudeLogo from "../../../mcp-tool-icons/claude.svg?raw";
import clineLogo from "../../../mcp-tool-icons/cline.svg?raw";
import codexLogo from "../../../mcp-tool-icons/codex.svg?raw";
import continueLogo from "../../../mcp-tool-icons/continue.svg?raw";
import cursorLogo from "../../../mcp-tool-icons/cursor.svg?raw";
import firebaseStudioLogo from "../../../mcp-tool-icons/firebase-studio.svg?raw";
import geminiLogo from "../../../mcp-tool-icons/gemini.svg?raw";
import githubCopilotLogo from "../../../mcp-tool-icons/github-copilot.svg?raw";
import gooseLogo from "../../../mcp-tool-icons/goose.svg?raw";
import kiroLogo from "../../../mcp-tool-icons/kiro.svg?raw";
import lmStudioLogo from "../../../mcp-tool-icons/lmstudio.svg?raw";
import openCodeLogo from "../../../mcp-tool-icons/opencode.svg?raw";
import rooCodeLogo from "../../../mcp-tool-icons/roocode.svg?raw";
import traeLogo from "../../../mcp-tool-icons/trae.svg?raw";
import vscodeLogo from "../../../mcp-tool-icons/vscode.svg?raw";
import warpLogo from "../../../mcp-tool-icons/warp.svg?raw";
import windsurfLogo from "../../../mcp-tool-icons/windsurf.svg?raw";
import zedLogo from "../../../mcp-tool-icons/zed.svg?raw";

/**
 * Brand SVG logos for IDE cards.
 * Real assets come from mcp-tool-icons; simple inline placeholders remain only
 * for IDEs that do not have a supplied logo yet.
 */

const S = 20; // standard icon size

function BrandIcon({ svg }: { svg: string }) {
  return <span className="ide-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function createBrandIcon(svg: string) {
  return function SvgBrandIcon() {
    return <BrandIcon svg={svg} />;
  };
}

export function AiderIcon() {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="5" fill="#00C853" />
      <path d="M12 6L7 18h2.5l1-2.5h3l1 2.5H17L12 6zm0 5l1.2 3h-2.4L12 11z" fill="#fff" />
    </svg>
  );
}

export function AugmentIcon() {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="5" fill="#6C3AED" />
      <circle cx="12" cy="12" r="4" stroke="#fff" strokeWidth="2" fill="none" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GenericIdeIcon() {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="5" fill="#555" />
      <path d="M8 8l4 4-4 4M13 16h4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const CursorIcon = createBrandIcon(cursorLogo);
export const WindsurfIcon = createBrandIcon(windsurfLogo);
export const ClaudeDesktopIcon = createBrandIcon(claudeLogo);
export const ClaudeCodeIcon = createBrandIcon(claudeCodeLogo);
export const CodexIcon = createBrandIcon(codexLogo);
export const CopilotIcon = createBrandIcon(githubCopilotLogo);
export const ClineIcon = createBrandIcon(clineLogo);
export const AmpIcon = createBrandIcon(ampLogo);
export const ZedIcon = createBrandIcon(zedLogo);
export const GeminiIcon = createBrandIcon(geminiLogo);
export const RooCodeIcon = createBrandIcon(rooCodeLogo);
export const ContinueIcon = createBrandIcon(continueLogo);
export const VscodeIcon = createBrandIcon(vscodeLogo);
export const AntigravityIcon = createBrandIcon(antigravityLogo);
export const KiroIcon = createBrandIcon(kiroLogo);
export const FirebaseStudioIcon = createBrandIcon(firebaseStudioLogo);
export const AmazonQIcon = createBrandIcon(amazonQLogo);
export const GooseIcon = createBrandIcon(gooseLogo);
export const WarpIcon = createBrandIcon(warpLogo);
export const TraeIcon = createBrandIcon(traeLogo);
export const LmStudioIcon = createBrandIcon(lmStudioLogo);
export const OpenCodeIcon = createBrandIcon(openCodeLogo);
// 2026-05 expansion: VS 2022, Copilot CLI, Factory, Qwen Code, Kilo Code don't
// ship dedicated SVGs in mcp-tool-icons/ yet — reuse closest-fit brand or fall
// back to GenericIdeIcon. Replace with proper SVGs when added.

const IDE_ICON_MAP: Record<string, () => React.ReactNode> = {
  cursor: CursorIcon,
  windsurf: WindsurfIcon,
  windsurfNext: WindsurfIcon,
  claudeDesktop: ClaudeDesktopIcon,
  claudeCode: ClaudeCodeIcon,
  codexCli: CodexIcon,
  cline: ClineIcon,
  amp: AmpIcon,
  rooCode: RooCodeIcon,
  continueDev: ContinueIcon,
  copilot: CopilotIcon,
  vscode: VscodeIcon,
  zed: ZedIcon,
  geminiCli: GeminiIcon,
  antigravity: AntigravityIcon,
  kiro: KiroIcon,
  firebaseStudio: FirebaseStudioIcon,
  amazonQ: AmazonQIcon,
  goose: GooseIcon,
  warp: WarpIcon,
  trae: TraeIcon,
  aider: AiderIcon,
  augment: AugmentIcon,
  // 2026-05 expansion. Visual Studio 2022 reuses the VS Code mark (close-enough
  // visual identity since both are Microsoft IDEs); Copilot CLI reuses the
  // GitHub Copilot mark. Factory, Qwen Code, Kilo Code fall back to the generic
  // icon until first-party SVGs are added.
  vs2022: VscodeIcon,
  copilotCli: CopilotIcon,
  openCode: OpenCodeIcon,
  factoryDroid: GenericIdeIcon,
  qwenCode: GenericIdeIcon,
  kiloCode: GenericIdeIcon,
  lmStudio: LmStudioIcon,
};

export function getIdeIcon(ideKey: string): () => React.ReactNode {
  return IDE_ICON_MAP[ideKey] ?? GenericIdeIcon;
}
