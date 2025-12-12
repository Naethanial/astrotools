"use client";

import { EditableMathField, addStyles } from "react-mathquill";
import { useEffect } from "react";

type MathField = unknown;

export type MathQuillFieldProps = {
  latex: string;
  onChange: (latex: string, text: string) => void;
  onEnter: () => void;
  onFocus: () => void;
  onMount: (mathField: MathField) => void;
  autoCommands?: string;
  autoOperatorNames?: string;
};

export function MathQuillField({
  latex,
  onChange,
  onEnter,
  onFocus,
  onMount,
  autoCommands,
  autoOperatorNames,
}: MathQuillFieldProps) {
  const DEFAULT_AUTO_COMMANDS = [
    "pi",
    "theta",
    "tau",
    "phi",
    "sqrt",
    "int",
    "sum",
    "prod",
  ].join(" ");

  const DEFAULT_AUTO_OPERATOR_NAMES = [
    // Custom operator-style names (keep this short).
    // Functions (typed without a leading backslash)
    "sin",
    "cos",
    "tan",
    "sec",
    "csc",
    "cot",
    "asin",
    "acos",
    "atan",
    "sinh",
    "cosh",
    "tanh",
    "asinh",
    "acosh",
    "atanh",
    "log",
    "ln",
    "exp",
    "abs",
    "floor",
    "ceil",
    "round",
    "mod",
    "gcd",
    "lcm",
    "factorial",
    "combinations",
    "permutations",
    "nCr",
    "nPr",
  ].join(" ");

  const safeAutoCommands = (autoCommands ?? DEFAULT_AUTO_COMMANDS)
    .split(/\s+/)
    .filter(Boolean)
    // MathQuill expects command "names" here (no leading backslash).
    // Keep built-ins like sqrt/sin/int/etc; only filter invalid tokens.
    .filter((name) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(name))
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    .join(" ");

  const commandNameSet = new Set(safeAutoCommands.split(/\s+/).filter(Boolean));

  const safeAutoOperatorNames = (autoOperatorNames ?? DEFAULT_AUTO_OPERATOR_NAMES)
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(name))
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    // Prevent passing operator names that are already handled as commands,
    // which avoids the common "built-in operator name" runtime errors.
    .filter((name) => !commandNameSet.has(name))
    .join(" ");

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (typeof window === "undefined") return;
      const jqMod = await import("jquery");
      const jq =
        (jqMod as unknown as { default?: unknown }).default ?? (jqMod as unknown);
      (window as unknown as { jQuery?: unknown; $?: unknown }).jQuery = jq;
      (window as unknown as { jQuery?: unknown; $?: unknown }).$ = jq;
      await import("mathquill/build/mathquill.js");
      if (!cancelled) addStyles();
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <EditableMathField
      latex={latex}
      onChange={(mf) => {
        if (!mf) return;
        onChange(mf.latex(), mf.text());
      }}
      mathquillDidMount={(mf) => onMount(mf)}
      onFocus={onFocus}
      config={{
        spaceBehavesLikeTab: true,
        leftRightIntoCmdGoes: "up",
        restrictMismatchedBrackets: true,
        sumStartsWithNEquals: true,
        supSubsRequireOperand: true,
        charsThatBreakOutOfSupSub: "+-=<>",
        autoSubscriptNumerals: true,
        autoCommands: safeAutoCommands,
        autoOperatorNames: safeAutoOperatorNames,
        maxDepth: 10,
        substituteTextarea: () => document.createElement("textarea"),
        handlers: {
          enter: () => onEnter(),
        },
      }}
      className="w-full min-h-10 px-2 py-1 rounded-md border border-foreground/15 bg-background text-lg focus-within:ring-2 focus-within:ring-foreground/20"
    />
  );
}
