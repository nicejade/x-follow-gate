import { manifest } from "@/manifest";

describe("manifest", () => {
  it("limits host access and declares MV3", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual(["https://x.com/*", "https://twitter.com/*"]);
    expect(manifest.permissions).not.toContain("cookies");
  });
});
