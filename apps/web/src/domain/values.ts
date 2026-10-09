// Value compatibility checks for default values and asset variable values.
// Values travel as strings in the API (Variable.value: string, 1..255 chars).

import type { DataType } from "./model";
import { DEFAULT_STRING_LENGTH, LIMITS } from "./rules";

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// ISO-8601 date-time with timezone designator, e.g. 2018-01-01T00:00:00.00Z
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Returns an error message, or undefined when `value` fits `dataType`. */
export function checkValue(dataType: DataType, value: string, length?: number | null): string | undefined {
  if (value.length < 1) return "Value must not be empty.";
  if (value.length > LIMITS.variableValueMax) {
    return `Value is longer than ${LIMITS.variableValueMax} characters.`;
  }
  switch (dataType) {
    case "BOOLEAN":
      return value === "true" || value === "false" ? undefined : 'Expected "true" or "false".';
    case "INT": {
      if (!INTEGER.test(value)) return "Expected a whole number (INT).";
      const n = Number(value);
      return n < INT_MIN || n > INT_MAX ? "Out of INT range (32-bit)." : undefined;
    }
    case "LONG": {
      if (!INTEGER.test(value)) return "Expected a whole number (LONG).";
      const n = BigInt(value);
      return n < LONG_MIN || n > LONG_MAX ? "Out of LONG range (64-bit)." : undefined;
    }
    case "DOUBLE":
      return DECIMAL.test(value) && Number.isFinite(Number(value)) ? undefined : "Expected a number (DOUBLE).";
    case "TIMESTAMP":
      return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : "Expected an ISO-8601 timestamp, e.g. 2018-01-01T00:00:00.00Z.";
    case "STRING":
    case "BIG_STRING": {
      const max = length ?? DEFAULT_STRING_LENGTH;
      return value.length > max ? `Longer than the variable length (${max}).` : undefined;
    }
  }
}
