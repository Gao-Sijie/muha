import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";

test("Pi discovers and expands a Skill installed through configureWorkspace", async t => {
  const fixture = await controlledPi(t);
  const source = join(fixture.workspace, "source", "apricot");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: apricot\ndescription: Identify the apricot fixture\n---\nThe skill's secret word is orchard.\n");
  const runtime = await fixture.runtime();
  const configured = await runtime.configureWorkspace({ workspacePath: fixture.workspace,
    skills: [{ source: "./source", skillNames: ["apricot"] }] });
  assert.equal(configured.attempts[0].status, "succeeded", JSON.stringify(configured));
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  assert.equal((await completedTurn(session, "/skill:apricot Use this skill")).result.status, "completed");
  const messages = JSON.stringify(fixture.requests.at(-1).messages);
  assert.ok(messages.includes("The skill's secret word is orchard."));
  assert.ok(messages.includes("Identify the apricot fixture"));
});

test("Pi Skills configuration preserves canonical Workspace isolation, empty input and failed attempts", async t => {
  const fixture = await controlledPi(t);
  const other = join(fixture.root, "other-workspace"), alias = join(fixture.root, "workspace-alias");
  await mkdir(other);
  await symlink(fixture.workspace, alias, "dir");
  for (const [workspace, marker] of [[fixture.workspace, "ONLY_APRICOT"], [other, "ONLY_PLUM"]]) {
    const source = join(workspace, "source", "isolated");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), `---\nname: isolated\ndescription: Workspace-local fixture\n---\n${marker}\n`);
  }
  const runtime = await fixture.runtime();
  assert.deepEqual((await runtime.configureWorkspace({ workspacePath: alias })).attempts, []);
  const rejected = await runtime.configureWorkspace({ workspacePath: alias, skills: [{ source: "./missing-source" }] });
  assert.equal(rejected.attempts[0].status, "failed");
  for (const workspacePath of [alias, other]) {
    const configured = await runtime.configureWorkspace({ workspacePath, skills: [{ source: "./source", skillNames: ["isolated"] }] });
    assert.equal(configured.attempts[0].status, "succeeded");
    const session = await runtime.createSession({ harness: "pi", workspacePath,
      model: "controlled/controlled", approvalPolicy: "autoApprove" });
    assert.equal(session.reference.workspacePath, workspacePath === alias ? fixture.workspace : other);
    assert.equal((await completedTurn(session, "/skill:isolated Use this skill")).result.status, "completed");
  }
  assert.ok(JSON.stringify(fixture.requests[0].messages).includes("ONLY_APRICOT"));
  assert.equal(JSON.stringify(fixture.requests[0].messages).includes("ONLY_PLUM"), false);
  assert.ok(JSON.stringify(fixture.requests[1].messages).includes("ONLY_PLUM"));
  assert.equal(JSON.stringify(fixture.requests[1].messages).includes("ONLY_APRICOT"), false);
});
