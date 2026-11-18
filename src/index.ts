/**
 * @askwithai/sdk: call AskWithAI Decision Runtimes from your app.
 *
 * - `AskWithAI`: the client for the Decision API.
 * - `createDecision`: a typed decision function with schema checks, `verify()`, `escalateIf` and shadow adoption.
 * - `@askwithai/sdk/testing`: `createFauxAskWithAI()`, an in-process stand-in for tests.
 * - `@askwithai/sdk/cli`: the `run()` function behind the `askwithai` command, importable directly.
 * - The `askwithai` command: push, check, replay, mode.
 */
export * from "./client";
export * from "./decision";
