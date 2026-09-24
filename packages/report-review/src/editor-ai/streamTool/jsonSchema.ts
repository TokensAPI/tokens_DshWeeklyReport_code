import { jsonSchema, ToolSet } from "../ai-shim.js";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import isEqual from "lodash.isequal";
import { StreamTool } from "./streamTool.js";

function streamToolToJSONSchema(tool: StreamTool<any>): {
  schema: JSONSchema7;
  $defs?: Record<string, JSONSchema7Definition>;
} {
  // this adds the tool name as the "type". (not very clean way to do it)
  const { properties, required, $defs, ...rest } = tool.inputSchema;
  return {
    schema: {
      type: "object",
      description: tool.description,
      properties: {
        type: {
          type: "string",
          enum: [tool.name],
        },
        ...properties,
      },
      required: ["type", ...(required ?? [])],
      additionalProperties: false,
      ...rest,
    },
    $defs,
  };
}

/**
 * Creates the JSON Schema for an object that can represent a call to one or more StreamTools.
 *
 * E.g., given StreamTools add, delete, update, returns the json schema for an object that conforms to this shape:
 *
 * {
 *   "operations": [
 *     {
 *       "type": "add",
 *       ...parameters for add function...
 *     },
 *     {
 *       "type": "delete",
 *       ...parameters for delete function...
 *     },
 *     ...
 *   ]
 * }
 */
export function createStreamToolsArraySchema(
  streamTools: StreamTool<any>[],
): JSONSchema7 {
  const schemas = streamTools.map((tool) => streamToolToJSONSchema(tool));

  const $defs: Record<string, JSONSchema7Definition> = {};
  for (const schema of schemas) {
    for (const key in schema.$defs) {
      if ($defs[key] && !isEqual($defs[key], schema.$defs[key])) {
        throw new Error(`Duplicate, but different definition for ${key}`);
      }
      $defs[key] = schema.$defs[key];
    }
  }

  return {
    type: "object",
    properties: {
      reportId: {
        type: "string",
        description:
          "当前报告 ID。必须等于会话提示中给出的当前报告 ID。若与当前报告不一致，调用会被拒绝，以防误改其他报告。",
      },
      operations: {
        //description:
        // "Operations to apply to the document. Put all operations in this array in ONE tool call / function call. DO NOT use multiple operation arrays with parallel tool calls.",
        type: "array",
        items: {
          anyOf: schemas.map((schema) => schema.schema),
        },
      },
    },
    additionalProperties: false,
    required: ["operations"] as string[],
    $defs: Object.keys($defs).length > 0 ? $defs : undefined,
  };
}

export function streamToolsToToolSet(streamTools: StreamTool<any>[]): ToolSet {
  return {
    applyDocumentOperations: {
      inputSchema: jsonSchema(createStreamToolsArraySchema(streamTools)),
      outputSchema: jsonSchema({ type: "object" }),
    },
    lookup_data_ref: {
      description:
        "在本地数据源（行情镜像）中按查询词解析并取回某个数据指标的 reference 与序列值，用于在周报中引用/补齐/核对数据。若用户要加入或引用某个指标，先调用本工具；单次处理一个查询，如需多个指标可多次调用。",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要查询的数据指标描述，例如：巴西发运量 / BHP发运量 / 碳酸锂表观需求 / 沪锡收盘价。",
          },
          commodity: {
            type: "string",
            description: "可选：限定品种（如 铁矿 / 碳酸锂 / 锡 / 沥青）。留空则由宿主按当前报告品种自动过滤。",
          },
          windowMs: {
            type: "number",
            description: "可选：回看窗口（毫秒），取该区间内的序列；缺省时仅返回最新值与变化。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      outputSchema: jsonSchema({ type: "object" }),
    },
  };
}
