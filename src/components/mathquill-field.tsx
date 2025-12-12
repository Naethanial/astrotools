"use client";

import { EditableMathField, addStyles } from "react-mathquill";
import { useEffect, useMemo, useRef, useState } from "react";

type MathField = unknown;

const CONST_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type ConstantDef = {
  key: string;
  label: string;
  value: number;
};

export type MathQuillFieldProps = {
  latex: string;
  onChange: (latex: string, text: string) => void;
  onEnter: () => void;
  onFocus: () => void;
  onBackspaceWhenEmpty?: () => void;
  onMount: (mathField: MathField) => void;
  autoCommands?: string;
  autoOperatorNames?: string;
  constants?: ConstantDef[];
  onUpdateConstant?: (key: string, value: number) => void;
  wrapperClassName?: string;
  fieldClassName?: string;
};

export function MathQuillField({
  latex,
  onChange,
  onEnter,
  onFocus,
  onBackspaceWhenEmpty,
  onMount,
  autoCommands,
  autoOperatorNames,
  constants,
  onUpdateConstant,
  wrapperClassName,
  fieldClassName,
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

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mfRef = useRef<
    | null
    | {
        focus: () => void;
        write: (latex: string) => void;
        latex: () => string;
        text: () => string;
      }
  >(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(
    null
  );

  const [popoverKey, setPopoverKey] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(
    null
  );
  const [popoverValue, setPopoverValue] = useState("");

  const safeConstants = useMemo(() => {
    return (constants ?? []).filter((c) => CONST_ID_RE.test(c.key));
  }, [constants]);

  const filteredConstants = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return safeConstants;
    return safeConstants.filter((c) => {
      const key = c.key.toLowerCase();
      const label = (c.label ?? "").toLowerCase();
      return key.includes(q) || label.includes(q);
    });
  }, [pickerQuery, safeConstants]);

  function closePicker() {
    setPickerOpen(false);
    setPickerQuery("");
    setPickerIndex(0);
    setPickerPos(null);
  }

  function computePickerPos() {
    const root = wrapperRef.current;
    if (!root) return;
    const cursorEl = root.querySelector<HTMLElement>(".mq-cursor");
    const mqRoot = root.querySelector<HTMLElement>(".mq-root-block");
    const anchor = cursorEl ?? mqRoot ?? root;
    const r = anchor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    // Use wrapper-relative coordinates (picker is `position: absolute`).
    // This avoids "drift" when an ancestor creates a new containing block for fixed
    // positioning (e.g. via transforms/filters).
    const left = Math.max(8, r.left - rootRect.left);
    const top = Math.max(8, r.bottom - rootRect.top + 6);
    return { top, left };
  }

  function openPickerNearCursor() {
    const pos = computePickerPos();
    if (pos) setPickerPos(pos);
    setPickerOpen(true);
    setPickerQuery("");
    setPickerIndex(0);
  }

  function insertConstantEmbed(key: string) {
    if (!CONST_ID_RE.test(key)) return;
    const mf = mfRef.current;
    if (!mf) return;
    mf.write(`\\embed{const}[${key}]`);
    mf.write(" ");
    mf.focus();
    onChange(mf.latex(), mf.text());
  }

  function closePopover() {
    setPopoverKey(null);
    setPopoverPos(null);
    setPopoverValue("");
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (typeof window === "undefined") return;
      const jqMod = await import("jquery");
      const jq =
        (jqMod as unknown as { default?: unknown }).default ?? (jqMod as unknown);
      (window as unknown as { jQuery?: unknown; $?: unknown }).jQuery = jq;
      (window as unknown as { jQuery?: unknown; $?: unknown }).$ = jq;
      if (!cancelled) addStyles();

      // Register constant embed once per page-load.
      // This creates a single MathQuill "atom" rendered as a pill/badge, serialized as:
      //   \embed{const}[<id>]
      const w = window as unknown as {
        MathQuill?: { getInterface?: (v: number) => unknown };
        __mqConstEmbedRegistered?: boolean;
      };
      if (w.__mqConstEmbedRegistered) return;

      // IMPORTANT:
      // react-mathquill bundles its own MathQuill (@edtr-io/mathquill). Importing the
      // separate `mathquill` package here can register embeds on the wrong instance
      // and cause `EMBEDS[name] is not a function` at runtime.
      //
      // We rely on the bundled MathQuill exposing itself on `window.MathQuill`.
      const MQ = w.MathQuill?.getInterface?.(2) as
        | undefined
        | {
            registerEmbed?: (
              name: string,
              fn: (id?: string) => {
                htmlString: string;
                text: () => string;
                latex: () => string;
              }
            ) => void;
          };

      if (MQ?.registerEmbed) {
        MQ.registerEmbed("const", (id) => {
          const key = typeof id === "string" && CONST_ID_RE.test(id) ? id : "const";
          const pillClass =
            "mq-const-embed inline-flex flex-wrap items-center justify-center rounded-full border border-white/10 bg-white/10 px-[3px] py-0 text-[18px] leading-[18px] font-medium text-foreground text-center align-middle select-none box-border min-h-5 min-w-5 shadow-[inset_0px_0px_4px_0px_rgba(0,0,0,0.23)] [border-image:none]";

          // IMPORTANT: never interpolate untrusted HTML here. `key` is strictly validated.
          return {
            htmlString: `<span class="${pillClass}" data-const-id="${key}">${key}</span>`,
            text: () => key,
            latex: () => `\\embed{const}[${key}]`,
          };
        });
        w.__mqConstEmbedRegistered = true;
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const pos = computePickerPos();
      if (pos) setPickerPos(pos);
    };
    const scheduleUpdate = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    };

    function onDocMouseDown(e: MouseEvent) {
      const root = wrapperRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      closePicker();
    }
    document.addEventListener("mousedown", onDocMouseDown);

    // Keep the picker pinned to the field/cursor even if:
    // - the calculator resizes (side drawers open/close)
    // - any ancestor scroll container scrolls
    // - the viewport resizes
    window.addEventListener("resize", scheduleUpdate);
    document.addEventListener("scroll", scheduleUpdate, true);
    // Initial correction on next frame (after layout settles)
    scheduleUpdate();

    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("resize", scheduleUpdate);
      document.removeEventListener("scroll", scheduleUpdate, true);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!popoverKey) return;
    function onDocMouseDown(e: MouseEvent) {
      const root = wrapperRef.current;
      if (!root) return;
      // If click is inside the math field, we still allow the popover to stay open
      // unless it was a click on another embed (handled separately).
      if (e.target instanceof Node && root.contains(e.target)) return;
      closePopover();
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closePopover();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [popoverKey]);

  return (
    <div
      ref={wrapperRef}
      className={["relative overflow-visible", wrapperClassName].filter(Boolean).join(" ")}
      onKeyDown={(e) => {
        // Open @-picker.
        if (e.key === "@" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          openPickerNearCursor();
          return;
        }

        // Delete the entire line when the field is empty and the user presses Backspace.
        // (If not empty, let MathQuill handle Backspace normally.)
        if (!pickerOpen && e.key === "Backspace" && onBackspaceWhenEmpty) {
          const mf = mfRef.current;
          const latexNow = mf?.latex?.() ?? "";
          const textNow = mf?.text?.() ?? "";
          const isEmpty =
            latexNow.replace(/\s+/g, "") === "" && textNow.trim().length === 0;
          if (isEmpty) {
            e.preventDefault();
            e.stopPropagation();
            onBackspaceWhenEmpty();
            return;
          }
        }

        if (!pickerOpen) return;

        if (e.key === "Escape") {
          e.preventDefault();
          closePicker();
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPickerIndex((i) =>
            Math.min(i + 1, Math.max(0, filteredConstants.length - 1))
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPickerIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const pick = filteredConstants[pickerIndex] ?? filteredConstants[0];
          if (pick) insertConstantEmbed(pick.key);
          closePicker();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          setPickerQuery((q) => q.slice(0, -1));
          setPickerIndex(0);
          return;
        }
        if (/^[a-zA-Z0-9_]$/.test(e.key)) {
          e.preventDefault();
          setPickerQuery((q) => q + e.key);
          setPickerIndex(0);
        }
      }}
      onClick={(e) => {
        const target = (e.target as HTMLElement | null)?.closest?.(
          ".mq-const-embed"
        ) as HTMLElement | null;
        if (!target) return;
        const key = target.getAttribute("data-const-id") ?? "";
        if (!CONST_ID_RE.test(key)) return;
        const r = target.getBoundingClientRect();
        const root = wrapperRef.current;
        const rootRect = root?.getBoundingClientRect();
        e.preventDefault();
        e.stopPropagation();
        setPopoverKey(key);
        setPopoverPos({
          top: Math.max(8, r.bottom - (rootRect?.top ?? 0) + 6),
          left: Math.max(8, r.left - (rootRect?.left ?? 0)),
        });
        const def = safeConstants.find((c) => c.key === key);
        setPopoverValue(def ? String(def.value) : "");
      }}
    >
      <EditableMathField
        latex={latex}
        onChange={(mf) => {
          if (!mf) return;
          onChange(mf.latex(), mf.text());
        }}
        mathquillDidMount={(mf) => {
          mfRef.current = mf as unknown as {
            focus: () => void;
            write: (latex: string) => void;
            latex: () => string;
            text: () => string;
          };
          // Try to register embeds again after MathQuill is definitely initialized.
          // (If `window.MathQuill` is provided by react-mathquill's bundled MQ, it may
          // only exist after mount.)
          try {
            const w = window as unknown as {
              MathQuill?: { getInterface?: (v: number) => unknown };
              __mqConstEmbedRegistered?: boolean;
            };
            if (!w.__mqConstEmbedRegistered) {
              const MQ = w.MathQuill?.getInterface?.(2) as
                | undefined
                | {
                    registerEmbed?: (
                      name: string,
                      fn: (id?: string) => {
                        htmlString: string;
                        text: () => string;
                        latex: () => string;
                      }
                    ) => void;
                  };
              if (MQ?.registerEmbed) {
                MQ.registerEmbed("const", (id) => {
                  const key =
                    typeof id === "string" && CONST_ID_RE.test(id) ? id : "const";
                  const pillClass =
                    "mq-const-embed inline-flex flex-wrap items-center justify-center rounded-full border border-white/10 bg-white/10 px-[3px] py-0 text-[18px] leading-[18px] font-medium text-foreground text-center align-middle select-none box-border min-h-5 min-w-5 shadow-[inset_0px_0px_4px_0px_rgba(0,0,0,0.23)] [border-image:none]";
                  return {
                    htmlString: `<span class="${pillClass}" data-const-id="${key}">${key}</span>`,
                    text: () => key,
                    latex: () => `\\embed{const}[${key}]`,
                  };
                });
                w.__mqConstEmbedRegistered = true;
              }
            }
          } catch {
            // no-op
          }
          onMount(mf);
        }}
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
          maxDepth: 12,
          substituteTextarea: () => document.createElement("textarea"),
          handlers: {
            enter: () => onEnter(),
          },
        }}
        className={
          fieldClassName ??
          "w-full min-h-10 px-2 py-1 rounded-md border border-foreground/15 bg-white/10 bg-none text-lg focus-within:ring-2 focus-within:ring-foreground/20"
        }
      />

      {pickerOpen && pickerPos ? (
        <div
          className="absolute z-50 w-64 rounded-md border border-foreground/15 bg-background shadow-md"
          style={{ top: pickerPos.top, left: pickerPos.left }}
          onMouseDown={(e) => {
            // Avoid blur/focus fights with MathQuill.
            e.preventDefault();
          }}
        >
          <div className="px-2 py-1.5 text-xs text-foreground/60 border-b border-foreground/10">
            Insert constant {pickerQuery ? <span>(filter: {pickerQuery})</span> : null}
          </div>
          <div className="max-h-56 overflow-auto p-1">
            {filteredConstants.length === 0 ? (
              <div className="px-2 py-2 text-sm text-foreground/60">No matches</div>
            ) : (
              filteredConstants.map((c, idx) => (
                <button
                  key={c.key}
                  type="button"
                  className={[
                    "w-full text-left px-2 py-1.5 rounded-sm text-sm",
                    idx === pickerIndex
                      ? "bg-foreground/10 text-foreground"
                      : "hover:bg-foreground/5",
                  ].join(" ")}
                  onClick={() => {
                    insertConstantEmbed(c.key);
                    closePicker();
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{c.key}</span>
                    <span className="text-xs text-foreground/60">{c.value}</span>
                  </div>
                  {c.label ? (
                    <div className="text-xs text-foreground/60">{c.label}</div>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {popoverKey && popoverPos ? (
        <div
          className="absolute z-50 w-72 rounded-md border border-foreground/15 bg-background shadow-md p-3 space-y-2"
          style={{ top: popoverPos.top, left: popoverPos.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">{popoverKey}</div>
            <button
              type="button"
              className="text-xs text-foreground/60 hover:text-foreground"
              onClick={closePopover}
            >
              Close
            </button>
          </div>
          <div className="text-xs text-foreground/60">
            Edit constant value (also reflected in the side panel).
          </div>
          <label className="block text-xs text-foreground/60">Value</label>
          <input
            className="w-full rounded-md border border-foreground/15 bg-background px-2 py-1 text-sm"
            inputMode="decimal"
            value={popoverValue}
            onChange={(e) => setPopoverValue(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="px-2 py-1 text-sm rounded-md border border-foreground/15 hover:bg-foreground/5"
              onClick={closePopover}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!onUpdateConstant}
              className={[
                "px-2 py-1 text-sm rounded-md",
                onUpdateConstant
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-foreground/20 text-foreground/60 cursor-not-allowed",
              ].join(" ")}
              onClick={() => {
                if (!onUpdateConstant) return;
                const n = Number(popoverValue);
                if (!Number.isFinite(n)) return;
                onUpdateConstant(popoverKey, n);
                closePopover();
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
