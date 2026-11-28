import { Service, type Endpoint } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import type {
  EventSubscribeOutput,
  FormField,
  FormField1,
  FormInfo,
  FormInfo1,
  OpenCodeClient,
  PermissionRequest,
} from "@opencode/client/promise"
import { noTimeoutFetch } from "@opencode/util/no-timeout-fetch"
import { SessionMessage } from "@opencode/schema/session-message"
import { createInterface } from "node:readline/promises"
import { resolveSessionTarget } from "../session-target"
import { Env } from "../env"
import { interactiveTerminalUnavailable } from "../node/compat"

export async function runInteractive(input: {
  endpoint: Endpoint
  local: boolean
  directory: string
  continue: boolean
  session?: string
  prompt?: string
  auto: boolean
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(interactiveTerminalUnavailable)

  const client = OpenCode.make({
    baseUrl: input.endpoint.url,
    headers: Service.headers(input.endpoint),
    fetch: noTimeoutFetch,
  })
  const target = await resolveSessionTarget({
    client,
    location: { directory: input.directory },
    continue: input.continue,
    session: input.session,
    environment: input.local ? Env.session() : undefined,
    prepare: async (next) => ({ model: next.model, agent: next.agent }),
  })
  const state = {
    sessionID: target.session.id,
    promptID: undefined as string | undefined,
    promoted: false,
    terminal: undefined as { resolve(): void } | undefined,
    active: false,
    closed: false,
  }
  const handled = { permissions: new Set<string>(), forms: new Set<string>() }
  const terminal = new AbortController()
  const events = client.event.subscribe({ signal: terminal.signal })[Symbol.asyncIterator]()
  const initial = await events.next().catch((error) => {
    terminal.abort()
    throw error
  })
  if (initial.done) {
    terminal.abort()
    throw new Error("Event stream disconnected before interactive session startup")
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  prompt.on("close", () => {
    state.closed = true
    if (state.active) void client.session.interrupt({ sessionID: state.sessionID }).catch(reportError)
  })
  prompt.on("SIGINT", () => {
    process.stdout.write("^C\n")
    if (state.active) void client.session.interrupt({ sessionID: state.sessionID }).catch(reportError)
  })

  const consume = consumeEvents(client, events, state, prompt, input.auto, handled)
  consume.catch((error) => {
    reportError(error)
    process.exitCode = 1
    state.closed = true
    state.terminal?.resolve()
    prompt.close()
  })

  try {
    process.stdout.write(`OpenCode interactive session ${state.sessionID}\nType /help for commands, /exit to quit.\n`)
    await handlePending(client, prompt, state.sessionID, input.auto, handled)
    if (target.resume) await printHistory(client, state.sessionID)
    if (input.prompt?.trim()) await send(client, state, input.prompt)
    while (!state.closed) {
      const line = await ask(prompt, "> ")
      if (line === undefined) break
      const message = line.trim()
      if (!message) continue
      if (message === "/exit" || message === "/quit") break
      if (message === "/help") {
        process.stdout.write("/new starts a session; /session ID switches sessions; /exit quits.\n")
        continue
      }
      if (message === "/new") {
        const created = await client.session.create({ location: { directory: target.location.directory } })
        state.sessionID = created.id
        if (input.local)
          await client.session.environment({ sessionID: created.id, variables: Env.session() })
        process.stdout.write(`Started session ${created.id}\n`)
        continue
      }
      if (message.startsWith("/session ")) {
        const next = await client.session.get({ sessionID: message.slice("/session ".length).trim() })
        state.sessionID = next.id
        process.stdout.write(`Switched to session ${next.id}\n`)
        await printHistory(client, next.id)
        await handlePending(client, prompt, next.id, input.auto, handled)
        continue
      }
      if (message.startsWith("/")) {
        process.stdout.write("Unknown command. Type /help for commands.\n")
        continue
      }
      await send(client, state, message).catch(reportError)
    }
  } finally {
    prompt.close()
    terminal.abort()
    void events.return?.(undefined).catch(() => {})
    await consume.catch(() => {})
  }
}

async function handlePending(
  client: OpenCodeClient,
  prompt: ReturnType<typeof createInterface>,
  sessionID: string,
  auto: boolean,
  handled: { permissions: Set<string>; forms: Set<string> },
) {
  const permissions = await client.permission.list({ sessionID })
  const forms = await client.session.form.list({ sessionID })
  for (const request of permissions) {
    if (handled.permissions.has(request.id)) continue
    handled.permissions.add(request.id)
    await permission(client, prompt, request, auto)
  }
  for (const form of forms) {
    if (handled.forms.has(form.id)) continue
    handled.forms.add(form.id)
    await answerForm(client, prompt, form)
  }
}

async function printHistory(client: OpenCodeClient, sessionID: string) {
  const page = await client.message.list({ sessionID, limit: 40, order: "desc" })
  for (const message of page.data.toReversed()) {
    if (message.type === "user") {
      process.stdout.write(`\n> ${message.text}\n`)
      continue
    }
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) process.stdout.write(`${part.text}\n`)
      if (part.type === "tool") process.stdout.write(`[tool: ${part.name} - ${part.state.status}]\n`)
    }
  }
}

async function send(
  client: OpenCodeClient,
  state: {
    sessionID: string
    promptID?: string
    promoted: boolean
    terminal?: { resolve(): void }
    active: boolean
  },
  message: string,
) {
  const done = Promise.withResolvers<void>()
  const promptID = SessionMessage.ID.create()
  state.promptID = promptID
  state.promoted = false
  state.terminal = done
  state.active = true
  try {
    await client.session.prompt({ sessionID: state.sessionID, id: promptID, text: message, delivery: "steer" })
    await client.experimental.session.wait({ sessionID: state.sessionID })
    await done.promise
    process.stdout.write("\n")
  } finally {
    state.active = false
    state.promptID = undefined
    state.promoted = false
    state.terminal = undefined
  }
}

async function consumeEvents(
  client: OpenCodeClient,
  events: AsyncIterator<EventSubscribeOutput>,
  state: {
    sessionID: string
    promptID?: string
    promoted: boolean
    terminal?: { resolve(): void }
    active: boolean
    closed: boolean
  },
  prompt: ReturnType<typeof createInterface>,
  auto: boolean,
  handled: { permissions: Set<string>; forms: Set<string> },
) {
  const tools = new Map<string, string>()
  while (true) {
    const next = await events.next()
    if (next.done) {
      if (!state.closed) throw new Error("Event stream disconnected during interactive session")
      return
    }
    const event = next.value
    if (
      event.type === "permission.asked" &&
      !handled.permissions.has(event.data.id) &&
      (await ownsSession(client, event.data.sessionID, state.sessionID))
    ) {
      handled.permissions.add(event.data.id)
      await permission(client, prompt, event.data, auto)
    }
    if (event.type === "form.created") {
      const form = event.data.form
      if (!handled.forms.has(form.id) && (await ownsSession(client, form.sessionID, state.sessionID))) {
        handled.forms.add(form.id)
        await answerForm(client, prompt, form)
      }
    }
    if (
      event.type === "session.inbox.delivered" &&
      event.data.sessionID === state.sessionID &&
      event.data.inboxID === state.promptID
    )
      state.promoted = true
    if (!("sessionID" in event.data) || event.data.sessionID !== state.sessionID) continue
    if (event.type === "session.text.delta") process.stdout.write(event.data.delta)
    if (event.type === "session.reasoning.delta") continue
    if (event.type === "session.tool.input.started") tools.set(event.data.id, event.data.name)
    if (event.type === "session.tool.called")
      process.stdout.write(`\n[tool: ${tools.get(event.data.id) ?? "tool"}]\n`)
    if (event.type === "session.execution.failed")
      process.stderr.write(`\n${event.data.error.message}\n`)
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    )
      if (state.promoted) state.terminal?.resolve()
  }
}

async function permission(
  client: OpenCodeClient,
  prompt: ReturnType<typeof createInterface>,
  request: PermissionRequest,
  auto: boolean,
) {
  process.stdout.write(
    `\nPermission requested: ${request.action} (${request.resources.join(", ")})${request.message ? `\n${request.message}` : ""}\n`,
  )
  if (auto) {
    await client.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
    return
  }
  let decision: "once" | "always" | "reject" | undefined
  while (!decision) {
    const answer = await ask(prompt, "Allow once, always, or reject? [o/a/r] ")
    if (answer === undefined) {
      decision = "reject"
      break
    }
    decision =
      answer.trim().toLowerCase() === "o"
        ? "once"
        : answer.trim().toLowerCase() === "a"
          ? "always"
          : answer.trim().toLowerCase() === "r"
            ? "reject"
            : undefined
  }
  await client.permission.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    decision,
  })
}

async function answerForm(
  client: OpenCodeClient,
  prompt: ReturnType<typeof createInterface>,
  form: FormInfo | FormInfo1,
) {
  process.stdout.write(`\n${form.title}\n`)
  const answer: Record<string, string | number | boolean | string[]> = {}
  for (const field of form.fields) {
    if (field.type === "external") {
      process.stdout.write(`${field.url}\n`)
      while (true) {
        const value = await ask(prompt, `${field.title ?? field.key}: completed? [y/n] `)
        if (value === undefined) {
          await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id })
          return
        }
        if (value.trim().toLowerCase() === "y") {
          answer[field.key] = true
          break
        }
        if (value.trim().toLowerCase() !== "n") process.stdout.write("Enter y or n.\n")
      }
      continue
    }
    if (field.hidden) {
      if (field.default !== undefined) answer[field.key] = field.default
      continue
    }
    if (
      (field.when ?? []).some((when) => {
        const current = answer[when.key]
        if (current === undefined) return true
        const matches = Array.isArray(current) ? current.includes(String(when.value)) : current === when.value
        return when.op === "eq" ? !matches : matches
      })
    )
      continue
    if (field.default !== undefined) answer[field.key] = field.default
    if (field.type === "boolean") {
      while (true) {
        const value = await ask(prompt, `${field.title ?? field.key} [y/n]${field.default === undefined ? "" : ` (${field.default ? "y" : "n"})`}: `)
        if (value === undefined) {
          await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id })
          return
        }
        const normalized = value.trim().toLowerCase()
        if (!normalized && field.default !== undefined) {
          answer[field.key] = field.default
          break
        }
        if (["y", "yes", "true"].includes(normalized)) {
          answer[field.key] = true
          break
        }
        if (["n", "no", "false"].includes(normalized)) {
          answer[field.key] = false
          break
        }
        process.stdout.write("Enter y or n.\n")
      }
      continue
    }
    if (field.type !== "number" && field.type !== "integer" && field.type !== "string" && field.type !== "multiselect")
      continue
    const options = "options" in field ? (field.options ?? []).map((option) => `${option.value} (${option.label})`).join(", ") : ""
    while (true) {
      const value = await ask(
        prompt,
        `${field.title ?? field.key}${field.description ? ` - ${field.description}` : ""}${options ? ` [${options}]` : ""}${field.default === undefined ? "" : ` (${Array.isArray(field.default) ? field.default.join(",") : field.default})`}: `,
      )
      if (value === undefined) {
        await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id })
        return
      }
      const raw = value.trim()
      if (!raw && field.default !== undefined) break
      if (!raw && !field.required) {
        delete answer[field.key]
        break
      }
      let candidate: string | number | string[] = raw
      if (field.type === "number" || field.type === "integer") candidate = Number(raw)
      if (field.type === "multiselect") candidate = raw.split(",").map((item) => item.trim()).filter(Boolean)
      const error = formValueError(field, candidate)
      if (error) {
        process.stdout.write(`${error}\n`)
        continue
      }
      answer[field.key] = candidate
      break
    }
  }
  await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer })
}

function formValueError(field: Exclude<FormField | FormField1, { type: "external" | "boolean" }>, value: string | number | string[]) {
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a valid number."
    if (field.type === "integer" && !Number.isInteger(value)) return "Enter a whole number."
    if (typeof field.minimum === "number" && value < field.minimum) return `Enter a value of at least ${field.minimum}.`
    if (typeof field.maximum === "number" && value > field.maximum) return `Enter a value of at most ${field.maximum}.`
    return
  }
  if (field.type === "string") {
    if (typeof value !== "string") return "Enter text."
    if (field.required && !value) return "An answer is required."
    if (field.minLength !== undefined && value.length < field.minLength) return `Enter at least ${field.minLength} characters.`
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Enter no more than ${field.maxLength} characters.`
    if (field.options && !field.custom && !field.options.some((option) => option.value === value))
      return "Choose one of the listed options."
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Enter a value matching ${field.pattern}.`
      } catch {
        return "This form field has an invalid validation pattern."
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Enter a valid email address."
    if (field.format === "uri" && !URL.canParse(value)) return "Enter a valid URL."
    if (
      field.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) ||
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)
    )
      return "Enter a valid date (YYYY-MM-DD)."
    if (field.format === "date-time" && Number.isNaN(new Date(value).getTime())) return "Enter a valid date and time."
    return
  }
  if (!Array.isArray(value)) return "Enter selections separated by commas."
  if (field.required && value.length === 0) return "Select at least one option."
  if (field.minItems !== undefined && value.length < field.minItems) return `Select at least ${field.minItems} items.`
  if (field.maxItems !== undefined && value.length > field.maxItems) return `Select at most ${field.maxItems} items.`
  if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item)))
    return "Choose only listed options."
}

async function ask(
  prompt: ReturnType<typeof createInterface>,
  message: string,
) {
  try {
    return await prompt.question(message)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE")
      return undefined
    throw error
  }
}

async function ownsSession(client: OpenCodeClient, sessionID: string, root: string): Promise<boolean> {
  if (sessionID === root) return true
  const session = await client.session.get({ sessionID }).catch(() => undefined)
  if (!session?.parentID) return false
  return ownsSession(client, session.parentID, root)
}

function reportError(error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
}
