export function buildSweEnvInstruction(isSweContainer: boolean): string {
  if (!isSweContainer) return "";
  return `7. The development environment is already fully configured with the correct Python version and all dependencies pre-installed. Do NOT install packages, create virtual environments, or modify the Python installation. Just focus on understanding and fixing the bug.
8. VERIFY AGAINST REGRESSIONS, NOT JUST THE REPORTED BUG - Run the FULL test file/module/class that contains the code you changed, not a hand-picked single test. A fix that only passes the one test you wrote can still be WRONG if it silently breaks a sibling test in the same file that you never ran. Do NOT run the entire project's test suite though (too slow) - but always run the full test file most directly tied to your change.
9. Make the MINIMAL changes necessary to fix the issue. Do not refactor unrelated code.
10. TIME EFFICIENCY - Do NOT waste time on:
    - Unnecessary git archaeology (git log, git show). Focus on the CURRENT code, not its history, unless you deem it essential to fix the issue.
    - Re-running the same test with different pipe/grep/tail flags. Capture the full output ONCE and read it.
    - Guessing test class/function names. If unsure, grep for the class name first BEFORE running.
11. INFINITE LOOP PREVENTION - When running test suites or scripts that execute code you have modified, wrap the command with \`timeout\` to guard against inadvertent infinite loops (e.g., \`timeout 300 python -m pytest tests/test_xxx.py -xvs\`). No single test run should need more than 5 minutes.`;
}

export interface AgentPromptParams {
  tmpDir: string;
  isSweContainer: boolean;
  taskPrompt: string;
}

export function buildAgentPrompt({ tmpDir, isSweContainer, taskPrompt }: AgentPromptParams): string {
  const sweEnvInstruction = buildSweEnvInstruction(isSweContainer);
  return `You are an expert AI coding assistant. The target repository has ALREADY been cloned into your CURRENT WORKING DIRECTORY (\`${tmpDir}\`). 

CRITICAL INSTRUCTIONS:
1. Do NOT use \`git clone\` or download any repositories. The code is already here.
2. ALL your work (fixes and tests) must be done STRICTLY within your current working directory. Use relative paths (e.g., \`.\`) instead of absolute paths.
3. Do NOT explore, read, or modify files outside of your current working directory.
4. Focus only on fixing the issue described below and verifying your fix with tests.
5. You are running completely autonomously. There is NO human interaction. You must independently investigate, write the fix, verify it, and then STOP calling tools when you are done.
6. You are to complete the task and produce changes editing the files in this project. Do not stop without editing the files required to complete the task!
${sweEnvInstruction}

Issue Description:
${taskPrompt}`;
}
