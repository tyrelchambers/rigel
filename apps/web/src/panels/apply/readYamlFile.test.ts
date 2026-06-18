// @vitest-environment jsdom
import { expect, test } from "vitest";
import { isYamlFilename, readYamlFile } from "./readYamlFile";

test("isYamlFilename accepts .yaml/.yml, rejects others", () => {
  expect(isYamlFilename("deploy.yaml")).toBe(true);
  expect(isYamlFilename("deploy.YML")).toBe(true);
  expect(isYamlFilename("notes.txt")).toBe(false);
  expect(isYamlFilename("yaml")).toBe(false);
});

test("readYamlFile returns the file text for a yaml file", async () => {
  const file = new File(["kind: Pod\n"], "pod.yaml", { type: "text/yaml" });
  expect(await readYamlFile(file)).toBe("kind: Pod\n");
});

test("readYamlFile rejects a non-yaml file", async () => {
  const file = new File(["{}"], "data.json");
  await expect(readYamlFile(file)).rejects.toThrow(/not a \.yaml/i);
});
