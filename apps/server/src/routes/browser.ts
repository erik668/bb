import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { getInstalledPlugin } from "@bb/db";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import type { AppDeps } from "../types.js";
import type { BrowserControlService } from "../services/browser/browser-control.js";

export function registerBrowserRoutes(
  app: Hono,
  deps: AppDeps,
  browser: BrowserControlService,
): void {
  const { post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.browser;

  post(routes.snapshot, async (context, payload) => {
    if (getInstalledPlugin(deps.db, "browser-control")?.enabled !== true) {
      throw new ApiError(
        404,
        "browser_control_disabled",
        "Browser Control is disabled. Enable the built-in plugin to use it.",
      );
    }
    requireThreadEnvironment(deps.db, payload.threadId);
    return context.json(
      await browser.snapshot({
        signal: context.req.raw.signal,
        threadId: payload.threadId,
      }),
    );
  });
}
