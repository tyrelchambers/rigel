// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import type { CatalogApp } from "@helmsman/catalog";
import { ConfigureStep } from "./ConfigureStep";
import type { ConfigureValues } from "../wizardLogic";

const app = {
  id: "affine",
  name: "AFFiNE",
  tagline: "",
  description: "",
  category: "productivity",
  iconSystemName: "x",
  docsURL: "https://x",
  tags: [],
  matchImages: [],
  requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
  persistence: false,
  exposesIngress: false,
  installPromptTemplate: "",
} as unknown as CatalogApp;

const values: ConfigureValues = {
  instance: "affine",
  namespace: "default",
  hostname: "",
  nodePin: null,
  storageGiB: 0,
  clusterIssuer: "",
  notes: "",
};

const ALL_NS = ["default", "fleet-default", "kube-system", "cert-manager", "cnpg-system"];

function renderStep() {
  return render(
    <ConfigureStep
      app={app}
      values={values}
      setValues={() => {}}
      namespaces={ALL_NS}
      nodeNames={[]}
      clusterIssuers={[]}
      canAdvance
      onContinue={() => {}}
    />,
  );
}

describe("ConfigureStep namespace control", () => {
  test("namespace is a <select> listing every namespace, not a datalist", () => {
    const { container } = renderStep();

    // Regression guard: the old control was an <input list> + <datalist>, which
    // in real browsers filters suggestions by the current text ("default") and
    // so only showed namespaces containing that substring. There must be no
    // datalist, and the namespace options must live inside a real <select>.
    expect(container.querySelector("datalist")).toBeNull();

    const selects = Array.from(container.querySelectorAll("select"));
    const nsSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "fleet-default"),
    );
    expect(nsSelect).toBeDefined();

    const optionValues = Array.from(nsSelect!.options).map((o) => o.value);
    for (const ns of ALL_NS) expect(optionValues).toContain(ns);
    expect(nsSelect!.value).toBe("default");
  });
});
