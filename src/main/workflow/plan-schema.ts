export const planItemsSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "title",
      "instructions",
      "acceptance",
      "files",
      "dependsOn",
      "assignee",
    ],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      instructions: { type: "string" },
      acceptance: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      dependsOn: { type: "array", items: { type: "string" } },
      assignee: {
        type: "object",
        additionalProperties: false,
        required: ["agent", "model", "effort", "reason"],
        properties: {
          agent: { type: "string", enum: ["main", "worker"] },
          model: { type: "string" },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh", "max"],
          },
          reason: { type: "string" },
        },
      },
    },
  },
};
