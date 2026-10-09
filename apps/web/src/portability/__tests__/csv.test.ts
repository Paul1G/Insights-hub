import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseCsvRows, toCsv } from "../csv";

describe("csv", () => {
  it("parses quotes, escaped quotes, embedded newlines and CRLF", () => {
    const rows = parseCsvRows('a,b\r\n"x, y","He said ""hi"""\r\n"multi\nline",z\r\n');
    expect(rows).toEqual([["a", "b"], ["x, y", 'He said "hi"'], ["multi\nline", "z"]]);
  });

  it("detects semicolon delimiters and strips the BOM", () => {
    const text = "﻿name;type\nPump;acme.Pump\n";
    expect(detectDelimiter(text)).toBe(";");
    expect(parseCsv(text).rows).toEqual([{ name: "Pump", type: "acme.Pump" }]);
  });

  it("round-trips through toCsv", () => {
    const rows = [{ name: 'A "quoted", value', n: 3 }, { name: " padded ", n: 0 }];
    const parsed = parseCsv(toCsv(["name", "n"], rows));
    expect(parsed.rows).toEqual([{ name: 'A "quoted", value', n: "3" }, { name: " padded ", n: "0" }]);
  });

  it("ignores blank lines and fills missing cells", () => {
    expect(parseCsv("a,b,c\n\n1,2\n").rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });
});
