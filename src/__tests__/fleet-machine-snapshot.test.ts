/**
 * C1.2 — machine snapshot. Focus: identity from keychain-free metadata, the
 * hostname fallback, the null-when-logged-out gate, and runtime from the
 * injected process handle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cloud/credentials.js", () => ({
  readCredentialMetadata: vi.fn(),
}));

import { readCredentialMetadata } from "../cloud/credentials.js";
import { buildMachineSnapshot } from "../daemon/machine-snapshot.js";

const mockedMeta = vi.mocked(readCredentialMetadata);

const fakeProc = {
  pid: 4242,
  uptime: () => 123.7,
  memoryUsage: () => ({ rss: 99 }) as NodeJS.MemoryUsage,
} as unknown as Pick<NodeJS.Process, "pid" | "uptime" | "memoryUsage">;

describe("buildMachineSnapshot", () => {
  afterEach(() => mockedMeta.mockReset());

  it("returns null when there is no login", () => {
    mockedMeta.mockReturnValue(null);
    expect(buildMachineSnapshot()).toBeNull();
  });

  it("returns null when metadata has no machine_id", () => {
    mockedMeta.mockReturnValue({
      organization_id: "org_1",
      machine_id: "",
      machine_name: "laptop",
    });
    expect(buildMachineSnapshot()).toBeNull();
  });

  it("builds identity + runtime from metadata and the injected process", () => {
    mockedMeta.mockReturnValue({
      organization_id: "org_1",
      machine_id: "m_abc",
      machine_name: "work-laptop",
    });
    const snap = buildMachineSnapshot({ dashboardPort: 9850, proc: fakeProc });
    expect(snap).toMatchObject({
      machine_name: "work-laptop",
      cli_version: expect.any(String),
      daemon: {
        pid: 4242,
        uptime_s: 124,
        rss_bytes: 99,
        dashboard_port: 9850,
      },
    });
    expect(typeof snap?.os).toBe("string");
    expect(typeof snap?.arch).toBe("string");
  });

  it("falls back to the OS hostname when metadata records no name", () => {
    mockedMeta.mockReturnValue({
      organization_id: "org_1",
      machine_id: "m_abc",
      machine_name: "",
    });
    const snap = buildMachineSnapshot({ proc: fakeProc });
    expect(snap?.machine_name.length).toBeGreaterThan(0);
  });

  it("never carries a token in the snapshot", () => {
    mockedMeta.mockReturnValue({
      organization_id: "org_1",
      machine_id: "m_abc",
      machine_name: "host",
    });
    const snap = buildMachineSnapshot({ proc: fakeProc });
    expect(JSON.stringify(snap)).not.toMatch(/token|bearer|unerr_sk_/i);
  });
});
