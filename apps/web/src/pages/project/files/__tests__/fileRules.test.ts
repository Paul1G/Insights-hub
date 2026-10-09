import { describe, expect, it } from "vitest";
import { checkUpload, contentTypeFor, fileNameError, sanitizeFileName, uniqueFileName } from "../fileRules";

describe("file rules", () => {
  it("sanitises names for the Files API", () => {
    expect(sanitizeFileName("Pump manual v2.pdf")).toBe("Pump_manual_v2.pdf");
    expect(sanitizeFileName("a&b%c*d\\e/f.txt")).toBe("a_b_c_d_e_f.txt");
    expect(sanitizeFileName("   ")).toBe("file");
    expect(fileNameError("ok.pdf")).toBeUndefined();
    expect(fileNameError("bad name.pdf")).toMatch(/whitespace/);
    expect(fileNameError("")).toMatch(/required/);
    expect(fileNameError("A.pdf", ["a.PDF"])).toMatch(/same name/);
  });

  it("derives and checks content types", () => {
    expect(contentTypeFor("x.pdf", "")).toBe("application/pdf");
    expect(contentTypeFor("x.unknownext", "")).toBe("application/octet-stream");
    expect(checkUpload({ name: "manual.pdf", type: "application/pdf", size: 10 })).toEqual({ name: "manual.pdf", mimeType: "application/pdf", notes: [] });
    expect(checkUpload({ name: "manual.pdf", type: "image/png", size: 10 }).error).toMatch(/does not match/);
    expect(checkUpload({ name: "big.pdf", type: "application/pdf", size: 6 * 1024 * 1024 }).error).toMatch(/5 MB/);
    const unknown = checkUpload({ name: "model.step", type: "", size: 10 });
    expect(unknown.error).toBeUndefined();
    expect(unknown.notes[0]).toMatch(/Unknown extension/);
    const renamed = checkUpload({ name: "my file.txt", type: "text/plain", size: 1 });
    expect(renamed.name).toBe("my_file.txt");
    expect(renamed.notes[0]).toMatch(/Renamed/);
    // Replacing content keeps the target name and checks against its extension.
    expect(checkUpload({ name: "new.png", type: "image/png", size: 1 }, "old.pdf").error).toMatch(/does not match/);
  });

  it("makes names unique", () => {
    expect(uniqueFileName("a.pdf", ["A.pdf", "a_2.pdf"])).toBe("a_3.pdf");
    expect(uniqueFileName("readme", ["readme"])).toBe("readme_2");
    expect(uniqueFileName("x.txt", [])).toBe("x.txt");
  });
});
