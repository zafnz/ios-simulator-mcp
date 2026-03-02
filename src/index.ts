#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";

const execFileAsync = promisify(execFile);

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);

/**
 * Runs a command with arguments and returns the stdout and stderr
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { shell: false });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * Gets the IDB command path from environment variable or defaults to "idb"
 * @returns The path to the IDB executable
 * @throws Error if custom path is specified but doesn't exist
 */
function getIdbPath(): string {
  const customPath = process.env.IOS_SIMULATOR_MCP_IDB_PATH;

  if (customPath) {
    // Expand tilde if present
    const expandedPath = customPath.startsWith("~/")
      ? path.join(os.homedir(), customPath.slice(2))
      : customPath;

    // Check if the path exists
    if (!fs.existsSync(expandedPath)) {
      throw new Error(
        `Custom IDB path specified in IOS_SIMULATOR_MCP_IDB_PATH does not exist: ${expandedPath}`
      );
    }

    return expandedPath;
  }

  return "idb";
}

/**
 * Runs the idb command with the given arguments
 * @param args - arguments to pass to the idb command
 * @returns The stdout and stderr of the command
 * @see https://fbidb.io/docs/commands for documentation of available idb commands
 */
async function idb(...args: string[]) {
  return run(getIdbPath(), args);
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  return FILTERED_TOOLS.includes(toolName);
}

// --- Simulator lifecycle management ---

type Orientation =
  | "auto"
  | "portrait"
  | "landscape_right"
  | "upside_down"
  | "landscape_left";

/** Tracks managed simulators by session id */
const managedSimulators = new Map<
  string,
  { udid: string; name: string; owned: boolean; orientation: Orientation }
>();

/** Zod schema for the session id parameter, reused across all tools */
const sessionIdSchema = z
  .string()
  .max(128)
  .describe("Unique identifier for your session");

/**
 * Returns the UDID of the managed simulator for the given session id.
 * Throws if no simulator exists for that session.
 */
function getManagedSimulatorId(id: string): string {
  const sim = managedSimulators.get(id);
  if (!sim) {
    throw new Error(
      `No simulator is running for session "${id}". Call start_simulator first.`
    );
  }
  return sim.udid;
}

/**
 * Finds a device type identifier matching the given keyword.
 * Returns the first (newest) match since simctl lists newest devices first.
 */
async function findDeviceType(
  keyword: string
): Promise<{ identifier: string; name: string }> {
  const { stdout } = await run("xcrun", [
    "simctl",
    "list",
    "devicetypes",
    "-j",
  ]);
  const data = JSON.parse(stdout);
  const deviceTypes: { name: string; identifier: string }[] = data.devicetypes;
  const lowerKeyword = keyword.toLowerCase();
  const matches = deviceTypes.filter((dt) =>
    dt.name.toLowerCase().includes(lowerKeyword)
  );

  if (matches.length === 0) {
    throw new Error(
      `No device type found matching "${keyword}". Available types: ${deviceTypes.map((dt) => dt.name).join(", ")}`
    );
  }

  // Return the first match (newest model, since simctl lists newest first)
  return matches[0];
}

/**
 * Finds the latest available iOS runtime.
 */
async function findLatestRuntime(): Promise<string> {
  const { stdout } = await run("xcrun", [
    "simctl",
    "list",
    "runtimes",
    "-j",
  ]);
  const data = JSON.parse(stdout);
  const runtimes: { name: string; identifier: string; isAvailable: boolean }[] =
    data.runtimes;
  const iosRuntimes = runtimes.filter(
    (r) => r.isAvailable && r.name.startsWith("iOS")
  );

  if (iosRuntimes.length === 0) {
    throw new Error("No available iOS runtimes found. Install one via Xcode.");
  }

  return iosRuntimes[iosRuntimes.length - 1].identifier;
}

/**
 * Cleans up all managed simulators (shutdown + delete). Ignores errors.
 */
async function cleanupAllSimulators(): Promise<void> {
  for (const [id, { udid, owned }] of managedSimulators) {
    if (!owned) continue;
    try {
      await run("xcrun", ["simctl", "shutdown", udid]);
    } catch {
      // Ignore - might already be shut down
    }
    try {
      await run("xcrun", ["simctl", "delete", udid]);
    } catch {
      // Ignore cleanup errors
    }
  }
  managedSimulators.clear();
}

// --- Coordinate transformation ---

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Determines the effective orientation for a session given the screen dimensions.
 * "auto" detects portrait (w <= h) vs landscape_right (w > h).
 */
function getEffectiveOrientation(
  orientation: Orientation,
  screenWidth: number,
  screenHeight: number
): Orientation {
  if (orientation !== "auto") return orientation;
  return screenWidth > screenHeight ? "landscape_right" : "portrait";
}

/**
 * Transforms a frame from describe_all's rotated logical space to portrait space.
 * screenW/screenH are the root frame dimensions from describe_all.
 */
function transformFrame(
  frame: Frame,
  orientation: Orientation,
  screenW: number,
  screenH: number
): Frame {
  switch (orientation) {
    case "portrait":
    case "auto":
      return frame;

    case "landscape_right":
      return {
        x: frame.y,
        y: screenW - frame.x - frame.width,
        width: frame.height,
        height: frame.width,
      };

    case "landscape_left":
      return {
        x: screenH - frame.y - frame.height,
        y: frame.x,
        width: frame.height,
        height: frame.width,
      };

    case "upside_down":
      return {
        x: screenW - frame.x - frame.width,
        y: screenH - frame.y - frame.height,
        width: frame.width,
        height: frame.height,
      };
  }
}

/**
 * Formats a frame as an AXFrame string: "{{x, y}, {width, height}}"
 */
function formatAXFrame(frame: Frame): string {
  return `{{${frame.x}, ${frame.y}}, {${frame.width}, ${frame.height}}}`;
}

/**
 * Recursively transforms all frames in a describe_all/describe_point JSON tree.
 */
function transformElementTree(
  elements: any[],
  orientation: Orientation,
  screenW: number,
  screenH: number
): any[] {
  return elements.map((el) => {
    const transformed = { ...el };
    if (el.frame && (el.frame.width || el.frame.height)) {
      transformed.frame = transformFrame(el.frame, orientation, screenW, screenH);
      transformed.AXFrame = formatAXFrame(transformed.frame);
    }
    if (el.children && Array.isArray(el.children)) {
      transformed.children = transformElementTree(
        el.children,
        orientation,
        screenW,
        screenH
      );
    }
    return transformed;
  });
}

// --- Server setup ---

const server = new McpServer(
  {
    name: "ios-simulator",
    version: require("../package.json").version,
  },
  {
    instructions:
      "iOS Simulator MCP server. Use ui_describe_all to find tap coordinates — its frame values map directly to ui_tap coordinates in all orientations. Do not derive tap coordinates from ui_view screenshots, as they may not match the logical coordinate system (especially when the device is rotated). ui_view is useful for visual verification but ui_describe_all is the reliable way to navigate.",
  }
);

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/joshuayoes/ios-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/joshuayoes/ios-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

// --- Tool registrations ---

if (!isToolFiltered("start_simulator")) {
  server.tool(
    "start_simulator",
    "Creates, boots, and opens an iOS simulator for the given session. Each session can have one simulator — call destroy_simulator first to switch types.",
    {
      id: sessionIdSchema,
      type: z
        .string()
        .optional()
        .describe(
          'Device type keyword (e.g. "iPhone", "iPad", "iPhone 16 Pro"). Defaults to the latest iPhone.'
        ),
    },
    { title: "Start Simulator", readOnlyHint: false, openWorldHint: true },
    async ({ id, type }) => {
      try {
        const existing = managedSimulators.get(id);
        if (existing) {
          throw new Error(
            `A simulator is already running for session "${id}": "${existing.name}" (${existing.udid}). Call destroy_simulator first.`
          );
        }

        const keyword = type || "iPhone";
        const deviceType = await findDeviceType(keyword);
        const runtime = await findLatestRuntime();

        // Build device name: <SIM_NAME>_<id>_<type_keyword>
        const deviceName = `${id}_${keyword.toLowerCase().replace(/\s+/g, "-")}`;

        // Create the simulator
        const { stdout: udid } = await run("xcrun", [
          "simctl",
          "create",
          deviceName,
          deviceType.identifier,
          runtime,
        ]);

        // Boot the simulator
        await run("xcrun", ["simctl", "boot", udid]);

        // Ensure Simulator.app is open
        await run("open", ["-a", "Simulator.app"]);

        managedSimulators.set(id, {
          udid,
          name: deviceName,
          owned: true,
          orientation: "auto",
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Simulator started: "${deviceName}" (${deviceType.name}, ${udid})`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("destroy_simulator")) {
  server.tool(
    "destroy_simulator",
    "Shuts down and deletes the simulator for the given session. Call start_simulator afterwards to create a new one.",
    {
      id: sessionIdSchema,
    },
    { title: "Destroy Simulator", readOnlyHint: false, openWorldHint: true },
    async ({ id }) => {
      try {
        const sim = managedSimulators.get(id);
        if (!sim) {
          throw new Error(
            `No simulator is running for session "${id}".`
          );
        }

        const { name, udid, owned } = sim;

        if (owned) {
          await run("xcrun", ["simctl", "shutdown", udid]);
          await run("xcrun", ["simctl", "delete", udid]);
        }

        managedSimulators.delete(id);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: owned
                ? `Simulator destroyed: "${name}" (${udid})`
                : `Detached from simulator: "${name}" (${udid})`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error destroying simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("attach_simulator")) {
  server.tool(
    "attach_simulator",
    "Attaches to an existing, already-booted iOS simulator by UDID. Use this instead of start_simulator when you want to control a simulator that was created externally.",
    {
      id: sessionIdSchema,
      udid: z
        .string()
        .regex(
          /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
        )
        .describe("UDID of the simulator to attach to"),
    },
    { title: "Attach Simulator", readOnlyHint: false, openWorldHint: true },
    async ({ id, udid }) => {
      try {
        const existing = managedSimulators.get(id);
        if (existing) {
          throw new Error(
            `Session "${id}" is already attached to simulator "${existing.name}" (${existing.udid}). Call destroy_simulator first.`
          );
        }

        // Verify the simulator exists and is booted
        const { stdout } = await run("xcrun", [
          "simctl",
          "list",
          "devices",
          "-j",
        ]);
        const data = JSON.parse(stdout);
        let found: { name: string; state: string } | null = null;
        for (const runtime of Object.values(data.devices) as any[]) {
          for (const device of runtime) {
            if (device.udid === udid) {
              found = device;
              break;
            }
          }
          if (found) break;
        }

        if (!found) {
          throw new Error(`No simulator found with UDID "${udid}".`);
        }

        if (found.state !== "Booted") {
          throw new Error(
            `Simulator "${found.name}" (${udid}) is not booted (state: ${found.state}).`
          );
        }

        managedSimulators.set(id, {
          udid,
          name: found.name,
          owned: false,
          orientation: "auto",
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Attached to simulator: "${found.name}" (${udid})`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error attaching to simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("set_rotation_coords")) {
  server.tool(
    "set_rotation_coords",
    "Sets the coordinate rotation mapping for a session. By default (auto), portrait and landscape_right are detected automatically. Use this to override when the simulator is in landscape_left or upside_down orientation.",
    {
      id: sessionIdSchema,
      orientation: z
        .enum([
          "auto",
          "portrait",
          "landscape_right",
          "upside_down",
          "landscape_left",
        ])
        .describe(
          "The device orientation. 'auto' detects portrait vs landscape_right."
        ),
    },
    {
      title: "Set Rotation Coordinates",
      readOnlyHint: false,
      openWorldHint: false,
    },
    async ({ id, orientation }) => {
      try {
        const sim = managedSimulators.get(id);
        if (!sim) {
          throw new Error(
            `No simulator is running for session "${id}". Call start_simulator first.`
          );
        }

        sim.orientation = orientation as Orientation;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Coordinate rotation set to "${orientation}" for session "${id}".`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error setting rotation: ${toError(error).message}`,
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Describes accessibility information for the entire screen in the iOS Simulator",
    {
      id: sessionIdSchema,
    },
    { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
    async ({ id }) => {
      try {
        const sim = managedSimulators.get(id);
        if (!sim) {
          throw new Error(
            `No simulator is running for session "${id}". Call start_simulator first.`
          );
        }

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          sim.udid,
          "--json",
          "--nested"
        );

        const elements = JSON.parse(stdout);
        const screenFrame = elements[0]?.frame;

        if (screenFrame && (screenFrame.width || screenFrame.height)) {
          const orientation = getEffectiveOrientation(
            sim.orientation,
            screenFrame.width,
            screenFrame.height
          );

          if (orientation !== "portrait") {
            const transformed = transformElementTree(
              elements,
              orientation,
              screenFrame.width,
              screenFrame.height
            );
            return {
              isError: false,
              content: [
                { type: "text", text: JSON.stringify(transformed) },
              ],
            };
          }
        }

        return {
          isError: false,
          content: [{ type: "text", text: stdout }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing all of the ui: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap on the screen in the iOS Simulator",
    {
      id: sessionIdSchema,
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
    async ({ id, duration, x, y }) => {
      try {
        const udid = getManagedSimulatorId(id);

        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          udid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Tapped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error tapping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Input text into the iOS Simulator",
    {
      id: sessionIdSchema,
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    },
    { title: "UI Type", readOnlyHint: false, openWorldHint: true },
    async ({ id, text }) => {
      try {
        const udid = getManagedSimulatorId(id);

        const { stderr } = await idb(
          "ui",
          "text",
          "--udid",
          udid,
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          text
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Typed successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing text into the iOS Simulator: ${
                  toError(error).message
                }`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe on the screen in the iOS Simulator",
    {
      id: sessionIdSchema,
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .default("1")
        .describe("Swipe duration in seconds. Longer duration is a more controlled swipe."),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    },
    { title: "UI Swipe", readOnlyHint: false, openWorldHint: true },
    async ({ id, duration, x_start, y_start, x_end, y_end, delta }) => {
      try {
        const udid = getManagedSimulatorId(id);

        const { stderr } = await idb(
          "ui",
          "swipe",
          "--udid",
          udid,
          ...(duration ? ["--duration", duration] : []),
          ...(delta ? ["--delta", String(delta)] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x_start),
          String(y_start),
          String(x_end),
          String(y_end)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Swiped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      id: sessionIdSchema,
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
    async ({ id, x, y }) => {
      try {
        const sim = managedSimulators.get(id);
        if (!sim) {
          throw new Error(
            `No simulator is running for session "${id}". Call start_simulator first.`
          );
        }

        const { stdout, stderr } = await idb(
          "ui",
          "describe-point",
          "--udid",
          sim.udid,
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        // Transform the returned frame to portrait coordinates if rotated
        const element = JSON.parse(stdout);

        if (element.frame && (element.frame.width || element.frame.height)) {
          const { stdout: allOutput } = await idb(
            "ui",
            "describe-all",
            "--udid",
            sim.udid,
            "--json",
            "--nested"
          );
          const allData = JSON.parse(allOutput);
          const screenFrame = allData[0]?.frame;
          if (screenFrame) {
            const orientation = getEffectiveOrientation(
              sim.orientation,
              screenFrame.width,
              screenFrame.height
            );
            if (orientation !== "portrait") {
              element.frame = transformFrame(
                element.frame,
                orientation,
                screenFrame.width,
                screenFrame.height
              );
              element.AXFrame = formatAXFrame(element.frame);
            }
          }
        }

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(element) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point (${x}, ${y}): ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get the image content of a compressed screenshot of the current simulator view",
    {
      id: sessionIdSchema,
    },
    { title: "View Screenshot", readOnlyHint: true, openWorldHint: true },
    async ({ id }) => {
      try {
        const udid = getManagedSimulatorId(id);

        // Get screen dimensions in points from ui_describe_all
        const { stdout: uiDescribeOutput } = await idb(
          "ui",
          "describe-all",
          "--udid",
          udid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(uiDescribeOutput);
        const screenFrame = uiData[0]?.frame;
        if (!screenFrame) {
          throw new Error("Could not determine screen dimensions");
        }

        // Always use portrait dimensions (screenshot is in portrait pixel orientation)
        const pointWidth = Math.min(screenFrame.width, screenFrame.height);
        const pointHeight = Math.max(screenFrame.width, screenFrame.height);

        if (!pointWidth || !pointHeight) {
          throw new Error(
            "Simulator is still booting. Wait a few seconds and try again."
          );
        }

        // Generate unique file names with timestamp
        const ts = Date.now();
        const rawPng = path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`);
        const compressedJpg = path.join(
          TMP_ROOT_DIR,
          `ui-view-${ts}-compressed.jpg`
        );

        // Capture screenshot as PNG (always in physical portrait pixel orientation)
        await run("xcrun", [
          "simctl",
          "io",
          udid,
          "screenshot",
          "--type=png",
          "--",
          rawPng,
        ]);

        // Resize to logical point dimensions and compress to JPEG.
        // This ensures pixel coordinates in the image match idb tap coordinates.
        await run("sips", [
          "-z",
          String(pointHeight),
          String(pointWidth),
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80", // 80% quality
          rawPng,
          "--out",
          compressedJpg,
        ]);

        // Read and encode the compressed image
        const imageData = fs.readFileSync(compressedJpg);
        const base64Data = imageData.toString("base64");

        return {
          isError: false,
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: "Screenshot captured",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error capturing screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR;

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Takes a screenshot of the iOS Simulator",
    {
      id: sessionIdSchema,
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    },
    { title: "Take Screenshot", readOnlyHint: false, openWorldHint: true },
    async ({ id, output_path, type, display, mask }) => {
      try {
        const udid = getManagedSimulatorId(id);
        const absolutePath = ensureAbsolutePath(output_path);

        // command is weird, it responds with stderr on success and stdout is blank
        const { stderr: stdout } = await run("xcrun", [
          "simctl",
          "io",
          udid,
          "screenshot",
          ...(type ? [`--type=${type}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          absolutePath,
        ]);

        // throw if we don't get the expected success message
        if (stdout && !stdout.includes("Wrote screenshot to")) {
          throw new Error(stdout);
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: stdout,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error taking screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator using simctl directly",
    {
      id: sessionIdSchema,
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
        ),
      codec: z
        .enum(["h264", "hevc"])
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    },
    { title: "Record Video", readOnlyHint: false, openWorldHint: true },
    async ({ id, output_path, codec, display, mask, force }) => {
      try {
        const udid = getManagedSimulatorId(id);
        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        const outputFile = ensureAbsolutePath(output_path ?? defaultFileName);

        // Start the recording process
        const recordingProcess = spawn("xcrun", [
          "simctl",
          "io",
          udid,
          "recordVideo",
          ...(codec ? [`--codec=${codec}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          ...(force ? ["--force"] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          outputFile,
        ]);

        // Wait for recording to start
        await new Promise((resolve, reject) => {
          let errorOutput = "";

          recordingProcess.stderr.on("data", (data) => {
            const message = data.toString();
            if (message.includes("Recording started")) {
              resolve(true);
            } else {
              errorOutput += message;
            }
          });

          // Set timeout for start verification
          setTimeout(() => {
            if (recordingProcess.killed) {
              reject(new Error("Recording process terminated unexpectedly"));
            } else {
              resolve(true);
            }
          }, 3000);
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording started. The video will be saved to: ${outputFile}\nTo stop recording, use the stop_recording command.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops the simulator video recording using killall",
    {
      id: sessionIdSchema,
    },
    { title: "Stop Recording", readOnlyHint: false, openWorldHint: true },
    async ({ id }) => {
      try {
        const udid = getManagedSimulatorId(id);
        await run("pkill", ["-SIGINT", "-f", `simctl io ${udid} recordVideo`]);

        // Wait a moment for the video to finalize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Recording stopped successfully.",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("install_app")) {
  server.tool(
    "install_app",
    "Installs an app bundle (.app or .ipa) on the iOS Simulator",
    {
      id: sessionIdSchema,
      app_path: z
        .string()
        .max(1024)
        .describe(
          "Path to the app bundle (.app directory or .ipa file) to install"
        ),
    },
    { title: "Install App", readOnlyHint: false, openWorldHint: true },
    async ({ id, app_path }) => {
      try {
        const udid = getManagedSimulatorId(id);
        const absolutePath = path.isAbsolute(app_path)
          ? app_path
          : path.resolve(app_path);

        // Check if the app bundle exists
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`App bundle not found at: ${absolutePath}`);
        }

        // run() will throw if the command fails (non-zero exit code)
        await run("xcrun", ["simctl", "install", udid, absolutePath]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App installed successfully from: ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error installing app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("launch_app")) {
  server.tool(
    "launch_app",
    "Launches an app on the iOS Simulator by bundle identifier",
    {
      id: sessionIdSchema,
      bundle_id: z
        .string()
        .max(256)
        .describe(
          "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
        ),
      terminate_running: z
        .boolean()
        .optional()
        .describe(
          "Terminate the app if it is already running before launching"
        ),
    },
    { title: "Launch App", readOnlyHint: false, openWorldHint: true },
    async ({ id, bundle_id, terminate_running }) => {
      try {
        const udid = getManagedSimulatorId(id);

        // run() will throw if the command fails (non-zero exit code)
        const { stdout } = await run("xcrun", [
          "simctl",
          "launch",
          ...(terminate_running ? ["--terminate-running-process"] : []),
          udid,
          bundle_id,
        ]);

        // Extract PID from output if available
        // simctl launch outputs the PID as the first token in stdout
        const pidMatch = stdout.match(/^(\d+)/);
        const pid = pidMatch ? pidMatch[1] : null;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: pid
                ? `App ${bundle_id} launched successfully with PID: ${pid}`
                : `App ${bundle_id} launched successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error launching app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

process.stdin.on("close", async () => {
  console.log("iOS Simulator MCP Server closed");
  server.close();
  await cleanupAllSimulators();
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});
