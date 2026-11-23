// 为 @zcode/tui 的 runTui 包装一层 OSC 7501（Program Status Protocol）状态上报，
// 让 herdr-core / 支持 OSC 7501 的终端在不修改上游源码的前提下感知 Agent 生命周期状态。

const OSC_7501_PREFIX = "\x1b]7501;";
const OSC_7501_ST = "\x1b\\";
const DEFAULT_APP_NAME = "zcode";
const MAX_APP_BYTES = 32;
const MAX_MSG_BYTES = 180;
const MAX_REMEMBERED_EVENT_IDS = 2048;

const AUTO_BYPASSED_APPROVAL_TOOLS = new Set(["CreateWorkflow", "AmendWorkflow"]);
const TOOL_EVENTS = new Set([
  "tool_call_scheduled",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_result",
  "tool_call_error",
]);

function isOsc7501Disabled(env) {
  const raw = env?.ZCODE_OSC7501;
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function sanitizeAppName(raw) {
  if (typeof raw !== "string") return DEFAULT_APP_NAME;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_.+-]/g, "");
  if (!cleaned) return DEFAULT_APP_NAME;
  return cleaned.slice(0, MAX_APP_BYTES);
}

function encodeMessageBase64(text) {
  if (typeof text !== "string") return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  let bytes = Buffer.from(normalized, "utf8");
  if (bytes.byteLength > MAX_MSG_BYTES) {
    // 按字符逐步截断，避免把多字节 UTF-8 字符从中间切碎。
    let truncated = "";
    for (const ch of normalized) {
      const next = truncated + ch;
      if (Buffer.byteLength(next, "utf8") > MAX_MSG_BYTES - 1) break;
      truncated = next;
    }
    bytes = Buffer.from(`${truncated}…`, "utf8");
  }
  return bytes.toString("base64");
}

export function formatOsc7501({ state, app = DEFAULT_APP_NAME, kind, msg } = {}) {
  if (state === "clear") {
    return `${OSC_7501_PREFIX}state=clear${OSC_7501_ST}`;
  }
  const fields = [`state=${state}`];
  if (state === "blocked" && (kind === "permission" || kind === "question" || kind === "auth")) {
    fields.push(`kind=${kind}`);
  }
  fields.push(`app=${sanitizeAppName(app)}`);
  const encodedMsg = encodeMessageBase64(msg);
  if (encodedMsg) {
    fields.push(`msg=${encodedMsg}`);
  }
  return `${OSC_7501_PREFIX}${fields.join(":")}${OSC_7501_ST}`;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringField(record, key) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatBlockedMessage(request, kind) {
  const req = asRecord(request);
  const input = asRecord(req?.input);
  if (kind === "question") {
    const questions = Array.isArray(input?.questions) ? input.questions : undefined;
    const first = asRecord(questions?.[0]);
    return stringField(first, "question") ?? stringField(first, "header") ?? "Clarification needed";
  }
  const toolName = stringField(req, "toolName") ?? "tool";
  const detail =
    stringField(input, "command") ??
    stringField(input, "file_path") ??
    stringField(input, "path") ??
    stringField(input, "url") ??
    stringField(req, "reason");
  return detail ? `${toolName}: ${detail}` : toolName;
}

function formatErrorMessage(payload) {
  const rec = asRecord(payload);
  const err = asRecord(rec?.error);
  return (
    stringField(err, "message") ??
    stringField(rec, "message") ??
    stringField(rec, "reason") ??
    (typeof rec?.error === "string" && rec.error.trim() ? rec.error.trim() : undefined)
  );
}

function isAbortError(error) {
  if (!error || typeof error !== "object") return false;
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

function isMainSessionEvent(event, mainSessionId) {
  const payload = asRecord(event?.payload);
  if (TOOL_EVENTS.has(event?.type) && payload?.source === "subagent") {
    return false;
  }
  if (!mainSessionId) return true;
  const eventSessionId = typeof event?.sessionId === "string" ? event.sessionId : undefined;
  if (eventSessionId === undefined) return true;
  return eventSessionId === mainSessionId;
}

function rememberEventId(seen, event) {
  const id = typeof event?.id === "string" && event.id.length > 0 ? event.id : undefined;
  if (id === undefined) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > MAX_REMEMBERED_EVENT_IDS) {
    const excess = seen.size - MAX_REMEMBERED_EVENT_IDS;
    let removed = 0;
    for (const oldId of seen) {
      seen.delete(oldId);
      removed += 1;
      if (removed >= excess) break;
    }
  }
  return true;
}

export function wrapRunTuiWithOsc7501(upstreamRunTui, { env = process.env, proc = process } = {}) {
  return async function runTuiWithOsc7501(options) {
    const stdout = options?.stdout;
    if (
      isOsc7501Disabled(env) ||
      !stdout ||
      !stdout.isTTY ||
      typeof stdout.write !== "function"
    ) {
      return await upstreamRunTui(options);
    }

    const app = sanitizeAppName(env?.ZCODE_OSC7501_APP);
    let closed = false;
    let cleared = false;
    let turnActive = false;
    let compacting = false;
    let authBlocked = Boolean(options.loginRequired);
    let lastSequence;
    const pendingApprovals = [];
    const seenEventIds = new Set();

    const writeSequence = (sequence) => {
      if (sequence === lastSequence) return;
      lastSequence = sequence;
      try {
        stdout.write(sequence);
      } catch {
        // 终端流在异常关闭阶段可能已不可写；状态上报绝不能影响主流程退出。
      }
    };

    const syncStatus = (idleState = "idle", idleMsg) => {
      if (closed) return;
      if (pendingApprovals.length > 0) {
        const current = pendingApprovals[0];
        writeSequence(
          formatOsc7501({
            state: "blocked",
            kind: current.kind,
            app,
            msg: current.msg,
          }),
        );
        return;
      }
      if (turnActive || compacting) {
        writeSequence(formatOsc7501({ state: "working", app }));
        return;
      }
      if (authBlocked) {
        writeSequence(formatOsc7501({ state: "blocked", kind: "auth", app }));
        return;
      }
      writeSequence(formatOsc7501({ state: idleState, app, msg: idleMsg }));
    };

    const emitClearOnce = () => {
      if (cleared) return;
      cleared = true;
      closed = true;
      lastSequence = undefined;
      writeSequence(formatOsc7501({ state: "clear", app }));
    };

    const handleSessionEvent = (event) => {
      if (closed || !event || typeof event !== "object") return;
      if (!isMainSessionEvent(event, options.getMainSessionId?.())) return;
      if (!rememberEventId(seenEventIds, event)) return;

      const payload = asRecord(event.payload);
      switch (event.type) {
        case "turn_started":
          turnActive = true;
          syncStatus();
          break;
        case "turn_complete":
          turnActive = false;
          syncStatus("done");
          break;
        case "turn_error":
        case "model_error":
          if (stringField(payload, "turnPhase") === "compact") {
            compacting = false;
            syncStatus(turnActive ? undefined : "error", formatErrorMessage(payload));
            break;
          }
          turnActive = false;
          syncStatus("error", formatErrorMessage(payload));
          break;
        case "compact_started":
          compacting = true;
          syncStatus();
          break;
        case "compact_completed":
          compacting = false;
          syncStatus("idle");
          break;
        case "compact_failed":
          compacting = false;
          syncStatus("error", formatErrorMessage(payload));
          break;
        case "session_created":
        case "session_resumed":
        case "session_forked":
          if (!turnActive && !compacting) {
            syncStatus("idle");
          }
          break;
        default:
          break;
      }
    };

    const reconcileLoginFlag = (result) => {
      if (!result || typeof result !== "object" || typeof result.loginRequired !== "boolean") {
        return;
      }
      const nextAuthBlocked = result.loginRequired;
      if (nextAuthBlocked === authBlocked) return;
      authBlocked = nextAuthBlocked;
      if (!turnActive && !compacting && pendingApprovals.length === 0) {
        syncStatus("idle");
      }
    };

    const wrapPerTurnOptions = (callOptions) => {
      if (!callOptions || typeof callOptions !== "object") return callOptions;
      const upstreamOnEvent = callOptions.onEvent;
      return {
        ...callOptions,
        onEvent: (event) => {
          handleSessionEvent(event);
          return upstreamOnEvent?.(event);
        },
      };
    };

    const wrappedOptions = {
      ...options,
      ...(options.loadStartupOptions
        ? {
            loadStartupOptions: async () => {
              const startup = await options.loadStartupOptions();
              authBlocked = Boolean(startup?.loginRequired);
              syncStatus("idle");
              return startup;
            },
          }
        : {}),
      ...(options.subscribeSessionEvents
        ? {
            subscribeSessionEvents: (sink) =>
              options.subscribeSessionEvents((event) => {
                handleSessionEvent(event);
                sink(event);
              }),
          }
        : {}),
      ...(options.registerPermissionRequester
        ? {
            registerPermissionRequester: (requestPermission) =>
              options.registerPermissionRequester(async (request, requestOptions) => {
                if (requestOptions?.signal?.aborted) {
                  return await requestPermission(request, requestOptions);
                }
                const toolName = typeof request?.toolName === "string" ? request.toolName : "";
                if (AUTO_BYPASSED_APPROVAL_TOOLS.has(toolName)) {
                  return await requestPermission(request, requestOptions);
                }
                const kind = toolName === "AskUserQuestion" ? "question" : "permission";
                const entry = { kind, msg: formatBlockedMessage(request, kind) };
                pendingApprovals.push(entry);
                syncStatus();
                try {
                  return await requestPermission(request, requestOptions);
                } finally {
                  const index = pendingApprovals.indexOf(entry);
                  if (index !== -1) pendingApprovals.splice(index, 1);
                  syncStatus();
                }
              }),
          }
        : {}),
      ...(typeof options.submitPrompt === "function"
        ? {
            submitPrompt: async (prompt, callOptions) => {
              try {
                const result = await options.submitPrompt(prompt, wrapPerTurnOptions(callOptions));
                if (turnActive) {
                  turnActive = false;
                  syncStatus("done");
                }
                reconcileLoginFlag(result);
                return result;
              } catch (error) {
                if (turnActive) {
                  turnActive = false;
                  if (isAbortError(error) || callOptions?.abortSignal?.aborted) {
                    syncStatus("idle");
                  } else {
                    syncStatus("error", error instanceof Error ? error.message : String(error));
                  }
                }
                throw error;
              }
            },
          }
        : {}),
      ...(typeof options.sendInput === "function"
        ? {
            sendInput: async (input, callOptions) => {
              try {
                const result = await options.sendInput(input, wrapPerTurnOptions(callOptions));
                if (result && typeof result === "object" && result.kind === "started_turn") {
                  if (turnActive) {
                    turnActive = false;
                    syncStatus("done");
                  }
                  reconcileLoginFlag(result.result);
                } else if (
                  result &&
                  typeof result === "object" &&
                  result.kind === "command_result"
                ) {
                  reconcileLoginFlag(result.result);
                }
                return result;
              } catch (error) {
                if (turnActive && (isAbortError(error) || callOptions?.abortSignal?.aborted)) {
                  turnActive = false;
                  syncStatus("idle");
                }
                throw error;
              }
            },
          }
        : {}),
    };

    if (!options.loadStartupOptions) {
      syncStatus("idle");
    }

    proc.once("exit", emitClearOnce);
    try {
      return await upstreamRunTui(wrappedOptions);
    } finally {
      proc.off("exit", emitClearOnce);
      emitClearOnce();
    }
  };
}
