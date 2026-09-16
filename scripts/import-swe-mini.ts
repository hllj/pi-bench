import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateFailToPass } from "../src/task-validation";

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("Usage: bun run scripts/import-swe-bench.ts <path/to/swe-bench-lite.json>");
    process.exit(1);
  }

  const outDir = join(import.meta.dir, "../tasks/verified-mini");
  await mkdir(outDir, { recursive: true });

  const content = await readFile(inputFile, "utf-8");
  
  // Try to parse as JSON array or JSONL
  let instances: any[] = [];
  try {
    instances = JSON.parse(content);
  } catch (e) {
    // If not a JSON array, try JSONL
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    instances = lines.map(l => JSON.parse(l));
  }

  console.log(`[INFO] Found ${instances.length} SWE-bench instances.`);

  let count = 0;
  let corruptCount = 0;
  for (const instance of instances) {
    const failToPass = JSON.parse(instance.FAIL_TO_PASS);
    const validation = validateFailToPass(instance.repo, failToPass);

    const task: Record<string, unknown> = {
      id: instance.instance_id,
      repo: instance.repo,
      commit: instance.base_commit,
      prompt: instance.problem_statement,
      expectedDiff: instance.patch,
      testPatch: instance.test_patch, // The test diff to apply
      failToPass, // Tests that should fail before fix, pass after
      passToPass: JSON.parse(instance.PASS_TO_PASS), // Tests that should continue passing
      version: instance.version, // Project version (e.g. "3.1" for Django)
    };

    // The upstream mariushobbhahn/SWE-bench-verified-mini mirror ships at
    // least two instances (django__django-12209, sphinx-doc__sphinx-8265)
    // with a corrupted FAIL_TO_PASS: a docstring instead of a test id, and a
    // pytest node id truncated mid-parametrize. We can't recover the correct
    // value from this dataset (it's wrong at the source, not something our
    // import mangled), so flag it loudly instead of silently importing
    // garbage that later runs the FULL test suite or errors on a nonexistent
    // node id. The runtime guard in src/index.ts refuses to score these.
    if (!validation.valid) {
      corruptCount++;
      task.dataQuality = "corrupt-failToPass";
      console.warn(
        `[WARN] ${instance.instance_id}: corrupt FAIL_TO_PASS entr${validation.invalidIds.length === 1 ? "y" : "ies"}: ${JSON.stringify(validation.invalidIds)}`
      );
    }

    const outPath = join(outDir, `${task.id}.json`);
    await writeFile(outPath, JSON.stringify(task, null, 2));
    count++;
  }

  console.log(`[INFO] Generated ${count} tasks in ${outDir}`);
  if (corruptCount > 0) {
    console.warn(`[WARN] ${corruptCount} task(s) flagged with dataQuality: "corrupt-failToPass" -- excluded from scoring at run time.`);
  }
}

main().catch(console.error);
