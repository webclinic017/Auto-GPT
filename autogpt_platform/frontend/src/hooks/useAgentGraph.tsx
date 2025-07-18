import { CustomEdge } from "@/components/CustomEdge";
import { CustomNode } from "@/components/CustomNode";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";
import { InputItem } from "@/components/RunnerUIWrapper";
import { useToast } from "@/components/ui/use-toast";
import BackendAPI, {
  Block,
  BlockIOSubSchema,
  BlockUIType,
  formatEdgeID,
  Graph,
  GraphExecutionID,
  GraphID,
  GraphMeta,
  NodeExecutionResult,
  SpecialBlockID,
} from "@/lib/autogpt-server-api";
import {
  deepEquals,
  getTypeColor,
  removeEmptyStringsAndNulls,
  setNestedProperty,
} from "@/lib/utils";
import { MarkerType } from "@xyflow/react";
import Ajv from "ajv";
import { default as NextLink } from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ajv = new Ajv({ strict: false, allErrors: true });

export default function useAgentGraph(
  flowID?: GraphID,
  flowVersion?: number,
  flowExecutionID?: GraphExecutionID,
  passDataToBeads?: boolean,
) {
  const { toast } = useToast();
  const [router, searchParams, pathname] = [
    useRouter(),
    useSearchParams(),
    usePathname(),
  ];
  const [isScheduling, setIsScheduling] = useState(false);
  const [savedAgent, setSavedAgent] = useState<Graph | null>(null);
  const [agentDescription, setAgentDescription] = useState<string>("");
  const [agentName, setAgentName] = useState<string>("");
  const [availableNodes, setAvailableNodes] = useState<Block[]>([]);
  const [availableFlows, setAvailableFlows] = useState<GraphMeta[]>([]);
  const [updateQueue, setUpdateQueue] = useState<NodeExecutionResult[]>([]);
  const processedUpdates = useRef<NodeExecutionResult[]>([]);
  /**
   * User `request` to save or save&run the agent, or to stop the active run.
   * `state` is used to track the request status:
   * - none: no request
   * - saving: request was sent to save the agent
   *   and nodes are pending sync to update their backend ids
   * - running: request was sent to run the agent
   *   and frontend is enqueueing execution results
   * - stopping: a request to stop the active run has been sent; response is pending
   * - error: request failed
   */
  const [saveRunRequest, setSaveRunRequest] = useState<
    | {
        request: "none" | "save" | "run";
        state: "none" | "saving" | "error";
      }
    | {
        request: "run" | "stop";
        state: "running" | "stopping" | "error";
        activeExecutionID?: GraphExecutionID;
      }
  >({
    request: "none",
    state: "none",
  });
  // Determines if nodes backend ids are synced with saved agent (actual ids on the backend)
  const [nodesSyncedWithSavedAgent, setNodesSyncedWithSavedAgent] =
    useState(false);
  const [nodes, setNodes] = useState<CustomNode[]>([]);
  const [edges, setEdges] = useState<CustomEdge[]>([]);
  const { state, completeStep, incrementRuns } = useOnboarding();

  const api = useMemo(
    () => new BackendAPI(process.env.NEXT_PUBLIC_AGPT_SERVER_URL!),
    [],
  );

  // Load available blocks & flows
  useEffect(() => {
    api
      .getBlocks()
      .then((blocks) => setAvailableNodes(blocks))
      .catch();

    api
      .listGraphs()
      .then((flows) => setAvailableFlows(flows))
      .catch();

    api.connectWebSocket().catch((error) => {
      console.error("Failed to connect WebSocket:", error);
    });

    return () => {
      api.disconnectWebSocket();
    };
  }, [api]);

  // Subscribe to execution events
  useEffect(() => {
    const deregisterMessageHandler = api.onWebSocketMessage(
      "node_execution_event",
      (data) => {
        if (data.graph_exec_id != flowExecutionID) {
          return;
        }
        setUpdateQueue((prev) => [...prev, data]);
      },
    );

    const deregisterConnectHandler =
      flowID && flowExecutionID
        ? api.onWebSocketConnect(() => {
            // Subscribe to execution updates
            api
              .subscribeToGraphExecution(flowExecutionID)
              .then(() =>
                console.debug(
                  `Subscribed to updates for execution #${flowExecutionID}`,
                ),
              )
              .catch((error) =>
                console.error(
                  `Failed to subscribe to updates for execution #${flowExecutionID}:`,
                  error,
                ),
              );

            // Sync execution info to ensure it's up-to-date after (re)connect
            api
              .getGraphExecutionInfo(flowID, flowExecutionID)
              .then((execution) =>
                setUpdateQueue((prev) => {
                  if (!execution.node_executions) return prev;
                  return [...prev, ...execution.node_executions];
                }),
              );
          })
        : () => {};

    return () => {
      deregisterMessageHandler();
      deregisterConnectHandler();
    };
  }, [api, flowID, flowVersion, flowExecutionID]);

  const getOutputType = useCallback(
    (nodes: CustomNode[], nodeId: string, handleId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return "unknown";

      const outputSchema = node.data.outputSchema;
      if (!outputSchema) return "unknown";

      const outputHandle = outputSchema.properties[handleId] || {};
      if (!("type" in outputHandle)) return "unknown";
      return outputHandle.type;
    },
    [],
  );

  // Load existing graph
  const loadGraph = useCallback(
    (graph: Graph) => {
      setSavedAgent(graph);
      setAgentName(graph.name);
      setAgentDescription(graph.description);

      setNodes((prevNodes) => {
        const _newNodes = graph.nodes.map((node) => {
          const block = availableNodes.find(
            (block) => block.id === node.block_id,
          )!;
          if (!block) return null;
          const prevNode = prevNodes.find((n) => n.id === node.id);
          const flow =
            block.uiType == BlockUIType.AGENT
              ? availableFlows.find(
                  (flow) => flow.id === node.input_default.graph_id,
                )
              : null;
          const newNode: CustomNode = {
            id: node.id,
            type: "custom",
            position: {
              x: node?.metadata?.position?.x || 0,
              y: node?.metadata?.position?.y || 0,
            },
            data: {
              isOutputOpen: false,
              ...prevNode?.data,
              block_id: block.id,
              blockType: flow?.name || block.name,
              blockCosts: block.costs,
              categories: block.categories,
              description: block.description,
              title: `${block.name} ${node.id}`,
              inputSchema: block.inputSchema,
              outputSchema: block.outputSchema,
              hardcodedValues: node.input_default,
              webhook: node.webhook,
              uiType: block.uiType,
              connections: graph.links
                .filter((l) => [l.source_id, l.sink_id].includes(node.id))
                .map((link) => ({
                  edge_id: formatEdgeID(link),
                  source: link.source_id,
                  sourceHandle: link.source_name,
                  target: link.sink_id,
                  targetHandle: link.sink_name,
                })),
              backend_id: node.id,
            },
          };
          return newNode;
        });
        const newNodes = _newNodes.filter((n) => n !== null);
        setEdges(() =>
          graph.links.map((link) => {
            const adjustedSourceName = cleanupSourceName(link.source_name);
            return {
              id: formatEdgeID(link),
              type: "custom",
              data: {
                edgeColor: getTypeColor(
                  getOutputType(newNodes, link.source_id, adjustedSourceName!),
                ),
                sourcePos: newNodes.find((node) => node.id === link.source_id)
                  ?.position,
                isStatic: link.is_static,
                beadUp: 0,
                beadDown: 0,
                beadData: new Map<string, NodeExecutionResult["status"]>(),
              },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                strokeWidth: 2,
                color: getTypeColor(
                  getOutputType(newNodes, link.source_id, adjustedSourceName!),
                ),
              },
              source: link.source_id,
              target: link.sink_id,
              sourceHandle: adjustedSourceName || undefined,
              targetHandle: link.sink_name || undefined,
            };
          }),
        );
        return newNodes;
      });
    },
    [availableNodes, availableFlows, getOutputType],
  );

  const getFrontendId = useCallback(
    (backendId: string, nodes: CustomNode[]) => {
      const node = nodes.find((node) => node.data.backend_id === backendId);
      return node?.id;
    },
    [],
  );

  /** --- Smart Decision Maker Block helper functions --- */

  const isToolSourceName = (sourceName: string) =>
    sourceName.startsWith("tools_^_");

  const cleanupSourceName = (sourceName: string) =>
    isToolSourceName(sourceName) ? "tools" : sourceName;

  const getToolFuncName = (nodeId: string) => {
    const sinkNode = nodes.find((node) => node.id === nodeId);
    const sinkNodeName = sinkNode
      ? sinkNode.data.block_id === SpecialBlockID.AGENT
        ? sinkNode.data.hardcodedValues?.graph_id
          ? availableFlows.find(
              (flow) => flow.id === sinkNode.data.hardcodedValues.graph_id,
            )?.name || "agentexecutorblock"
          : "agentexecutorblock"
        : sinkNode.data.title.split(" ")[0]
      : "";

    return sinkNodeName;
  };

  const normalizeToolName = (str: string) =>
    str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase(); // This normalization rule has to match with the one on smart_decision_maker.py

  /** ------------------------------ */

  const updateEdgeBeads = useCallback(
    (executionData: NodeExecutionResult) => {
      setEdges((edges) => {
        return edges.map((e) => {
          const edge = { ...e, data: { ...e.data } } as CustomEdge;
          const execStatus =
            edge.data!.beadData ||
            new Map<string, NodeExecutionResult["status"]>();

          // Update execution status for input edges
          for (const key in executionData.input_data) {
            if (
              edge.target !== getFrontendId(executionData.node_id, nodes) ||
              edge.targetHandle !== key
            ) {
              continue;
            }

            // Store only the execution status
            execStatus.set(executionData.node_exec_id, executionData.status);
          }

          // Calculate bead counts based on execution status
          let beadUp = 0;
          let beadDown = 0;

          execStatus.forEach((status: NodeExecutionResult["status"]) => {
            beadUp++;
            if (status !== "INCOMPLETE") {
              // Count any non-incomplete execution as consumed
              beadDown++;
            }
          });

          // For static edges, ensure beadUp is always beadDown + 1
          // This is because static edges represent reusable inputs that are never fully consumed
          // The +1 represents the input that's still available for reuse
          if (edge.data?.isStatic && beadUp > 0) {
            beadUp = beadDown + 1;
          }

          // Update edge data
          edge.data!.beadUp = beadUp;
          edge.data!.beadDown = beadDown;

          return edge;
        });
      });
    },
    [getFrontendId, nodes],
  );

  const addExecutionDataToNode = useCallback(
    (node: CustomNode, executionData: NodeExecutionResult) => {
      if (!executionData.output_data) {
        console.warn(
          `Execution data for node ${executionData.node_id} is empty, skipping update`,
        );
        return node;
      }

      const executionResults = [
        // Execution updates are not cumulative, so we need to filter out the old ones.
        ...(node.data.executionResults?.filter(
          (result) => result.execId !== executionData.node_exec_id,
        ) || []),
        {
          execId: executionData.node_exec_id,
          data: {
            "[Input]": [executionData.input_data],
            ...executionData.output_data,
          },
          status: executionData.status,
        },
      ];

      const statusRank = {
        RUNNING: 0,
        QUEUED: 1,
        INCOMPLETE: 2,
        TERMINATED: 3,
        COMPLETED: 4,
        FAILED: 5,
      };
      const status = executionResults
        .map((v) => v.status)
        .reduce((a, b) => (statusRank[a] < statusRank[b] ? a : b));

      return {
        ...node,
        data: {
          ...node.data,
          status,
          executionResults,
          isOutputOpen: true,
        },
      };
    },
    [],
  );

  const updateNodesWithExecutionData = useCallback(
    (executionData: NodeExecutionResult) => {
      if (!executionData.node_id) return;
      if (passDataToBeads) {
        updateEdgeBeads(executionData);
      }
      setNodes((nodes) => {
        const nodeId = nodes.find(
          (node) => node.data.backend_id === executionData.node_id,
        )?.id;
        if (!nodeId) {
          console.error(
            "Node not found for execution data:",
            executionData,
            "This shouldn't happen and means that the frontend and backend are out of sync.",
          );
          return nodes;
        }
        return nodes.map((node) =>
          node.id === nodeId
            ? addExecutionDataToNode(node, executionData)
            : node,
        );
      });
    },
    [passDataToBeads, updateEdgeBeads],
  );

  // Load graph
  useEffect(() => {
    if (!flowID || availableNodes.length == 0) return;

    api.getGraph(flowID, flowVersion).then((graph) => {
      console.debug("Loading graph");
      loadGraph(graph);
    });
  }, [flowID, flowVersion, availableNodes, api, loadGraph]);

  // Update nodes with execution data
  useEffect(() => {
    if (updateQueue.length === 0 || !nodesSyncedWithSavedAgent) {
      return;
    }
    setUpdateQueue((prev) => {
      prev.forEach((data) => {
        updateNodesWithExecutionData(data);
        // Execution updates are not cumulative, so we need to filter out the old ones.
        processedUpdates.current = processedUpdates.current.filter(
          (update) => update.node_exec_id !== data.node_exec_id,
        );
        processedUpdates.current.push(data);
      });
      return [];
    });
  }, [updateQueue, nodesSyncedWithSavedAgent, updateNodesWithExecutionData]);

  const validateNodes = useCallback((): string | null => {
    let errorMessage = null;

    nodes.forEach((node) => {
      const validate = ajv.compile(node.data.inputSchema);
      const errors = {} as { [key: string]: string };

      // Validate values against schema using AJV
      const inputData =
        node.data.uiType === BlockUIType.AGENT
          ? node.data.hardcodedValues?.data || {}
          : node.data.hardcodedValues || {};
      const valid = validate(inputData);
      if (!valid) {
        // Populate errors if validation fails
        validate.errors?.forEach((error) => {
          // Skip error if there's an edge connected
          const path =
            "dataPath" in error
              ? (error.dataPath as string)
              : error.instancePath;
          const handle = path.split(/[\/.]/)[0];
          if (
            node.data.connections.some(
              (conn) => conn.target === node.id || conn.targetHandle === handle,
            )
          ) {
            return;
          }
          console.warn(`Error in ${node.data.blockType}: ${error}`, {
            data: inputData,
            schema: node.data.inputSchema,
          });
          errorMessage = error.message || "Invalid input";
          if (path && error.message) {
            const key = path.slice(1);
            setNestedProperty(
              errors,
              key,
              error.message[0].toUpperCase() + error.message.slice(1),
            );
          } else if (error.keyword === "required") {
            const key = error.params.missingProperty;
            setNestedProperty(errors, key, "This field is required");
          }
        });
      }

      Object.entries(node.data.inputSchema.properties || {}).forEach(
        ([key, schema]) => {
          if (schema.depends_on) {
            const dependencies = schema.depends_on;

            // Check if dependent field has value
            const hasValue =
              inputData[key] != null ||
              ("default" in schema && schema.default != null);

            const mustHaveValue = node.data.inputSchema.required?.includes(key);

            // Check for missing dependencies when dependent field is present
            const missingDependencies = dependencies.filter(
              (dep) =>
                !inputData[dep as keyof typeof inputData] ||
                String(inputData[dep as keyof typeof inputData]).trim() === "",
            );

            if ((hasValue || mustHaveValue) && missingDependencies.length > 0) {
              setNestedProperty(
                errors,
                key,
                `Requires ${missingDependencies.join(", ")} to be set`,
              );
              errorMessage = `Field ${key} requires ${missingDependencies.join(", ")} to be set`;
            }

            // Check if field is required when dependencies are present
            const hasAllDependencies = dependencies.every(
              (dep) =>
                inputData[dep as keyof typeof inputData] &&
                String(inputData[dep as keyof typeof inputData]).trim() !== "",
            );

            if (hasAllDependencies && !hasValue) {
              setNestedProperty(
                errors,
                key,
                `${key} is required when ${dependencies.join(", ")} are set`,
              );
              errorMessage = `${key} is required when ${dependencies.join(", ")} are set`;
            }
          }
        },
      );

      // Set errors
      setNodes((nodes) => {
        return nodes.map((n) => {
          if (n.id === node.id) {
            return {
              ...n,
              data: {
                ...n.data,
                errors,
              },
            };
          }
          return n;
        });
      });
    });

    return errorMessage;
  }, [nodes]);

  // Handle user requests
  useEffect(() => {
    // Ignore none request
    if (saveRunRequest.request === "none") {
      return;
    }
    // Display error message
    if (saveRunRequest.state === "error") {
      if (saveRunRequest.request === "save") {
        toast({
          variant: "destructive",
          title: `Error saving agent`,
          duration: 2000,
        });
      } else if (saveRunRequest.request === "run") {
        toast({
          variant: "destructive",
          title: `Error saving&running agent`,
          duration: 2000,
        });
      } else if (saveRunRequest.request === "stop") {
        toast({
          variant: "destructive",
          title: `Error stopping agent`,
          duration: 2000,
        });
      }
      // Reset request
      setSaveRunRequest({
        request: "none",
        state: "none",
      });
      return;
    }
    // When saving request is done
    if (
      saveRunRequest.state === "saving" &&
      savedAgent &&
      nodesSyncedWithSavedAgent
    ) {
      // Reset request if only save was requested
      if (saveRunRequest.request === "save") {
        setSaveRunRequest({
          request: "none",
          state: "none",
        });
        // If run was requested, run the agent
      } else if (saveRunRequest.request === "run") {
        const validationError = validateNodes();
        if (validationError) {
          toast({
            title: `Validation failed: ${validationError}`,
            variant: "destructive",
            duration: 2000,
          });
          setSaveRunRequest({
            request: "none",
            state: "none",
          });
          return;
        }
        setSaveRunRequest({ request: "run", state: "running" });
        api
          .executeGraph(savedAgent.id, savedAgent.version)
          .then((graphExecution) => {
            setSaveRunRequest({
              request: "run",
              state: "running",
              activeExecutionID: graphExecution.graph_exec_id,
            });

            // Update URL params
            const path = new URLSearchParams(searchParams);
            path.set("flowID", savedAgent.id);
            path.set("flowVersion", savedAgent.version.toString());
            path.set("flowExecutionID", graphExecution.graph_exec_id);
            router.push(`${pathname}?${path.toString()}`);
            if (state?.completedSteps.includes("BUILDER_SAVE_AGENT")) {
              completeStep("BUILDER_RUN_AGENT");
            }
          })
          .catch((error) => {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            toast({
              variant: "destructive",
              title: "Error saving agent",
              description: errorMessage,
            });
            setSaveRunRequest({ request: "run", state: "error" });
          });

        processedUpdates.current = [];
      }
    }
    // Handle stop request
    if (
      saveRunRequest.request === "stop" &&
      saveRunRequest.state != "stopping" &&
      savedAgent &&
      saveRunRequest.activeExecutionID
    ) {
      api.stopGraphExecution(savedAgent.id, saveRunRequest.activeExecutionID);
    }
  }, [
    api,
    toast,
    saveRunRequest,
    savedAgent,
    nodesSyncedWithSavedAgent,
    validateNodes,
  ]);

  useEffect(() => {
    if (!flowID || !flowExecutionID) {
      return;
    }

    const fetchExecutions = async () => {
      const execution = await api.getGraphExecutionInfo(
        flowID,
        flowExecutionID,
      );
      if (
        (execution.status === "QUEUED" || execution.status === "RUNNING") &&
        saveRunRequest.request === "none"
      ) {
        setSaveRunRequest({
          request: "run",
          state: "running",
          activeExecutionID: flowExecutionID,
        });
      }
      setUpdateQueue((prev) => {
        if (!execution.node_executions) return prev;
        return [...prev, ...execution.node_executions];
      });

      const cancelGraphExecListener = api.onWebSocketMessage(
        "graph_execution_event",
        (graphExec) => {
          if (graphExec.id != flowExecutionID) {
            return;
          }
          if (
            graphExec.status === "FAILED" &&
            graphExec?.stats?.error
              ?.toLowerCase()
              ?.includes("insufficient balance")
          ) {
            // Show no credits toast if user has low credits
            toast({
              variant: "destructive",
              title: "Credits low",
              description: (
                <div>
                  Agent execution failed due to insufficient credits.
                  <br />
                  Go to the{" "}
                  <NextLink
                    className="text-purple-300"
                    href="/marketplace/credits"
                  >
                    Credits
                  </NextLink>{" "}
                  page to top up.
                </div>
              ),
              duration: 5000,
            });
          }
          if (
            graphExec.status === "COMPLETED" ||
            graphExec.status === "TERMINATED" ||
            graphExec.status === "FAILED"
          ) {
            cancelGraphExecListener();
            setSaveRunRequest({ request: "none", state: "none" });
            incrementRuns();
          }
        },
      );
    };

    fetchExecutions();
  }, [flowID, flowExecutionID, incrementRuns]);

  // Check if node ids are synced with saved agent
  useEffect(() => {
    // Check if all node ids are synced with saved agent (frontend and backend)
    if (!savedAgent || nodes?.length === 0) {
      setNodesSyncedWithSavedAgent(false);
      return;
    }
    // Find at least one node that has backend id existing on any saved agent node
    // This will works as long as ALL ids are replaced each time the graph is run
    const oneNodeSynced = savedAgent.nodes.some(
      (backendNode) => backendNode.id === nodes[0].data.backend_id,
    );
    setNodesSyncedWithSavedAgent(oneNodeSynced);
  }, [savedAgent, nodes]);

  const prepareNodeInputData = useCallback(
    (node: CustomNode) => {
      console.debug(
        "Preparing input data for node:",
        node.id,
        node.data.blockType,
      );

      const blockSchema = availableNodes.find(
        (n) => n.id === node.data.block_id,
      )?.inputSchema;

      if (!blockSchema) {
        console.error(`Schema not found for block ID: ${node.data.block_id}`);
        return {};
      }

      const getNestedData = (
        schema: BlockIOSubSchema,
        values: { [key: string]: any },
      ): { [key: string]: any } => {
        let inputData: { [key: string]: any } = {};

        if ("properties" in schema) {
          Object.keys(schema.properties).forEach((key) => {
            if (values[key] !== undefined) {
              if (
                "properties" in schema.properties[key] ||
                "additionalProperties" in schema.properties[key]
              ) {
                inputData[key] = getNestedData(
                  schema.properties[key],
                  values[key],
                );
              } else {
                inputData[key] = values[key];
              }
            }
          });
        }

        if ("additionalProperties" in schema) {
          inputData = { ...inputData, ...values };
        }

        return inputData;
      };

      const inputData = getNestedData(blockSchema, node.data.hardcodedValues);

      console.debug(
        `Final prepared input for ${node.data.blockType} (${node.id}):`,
        inputData,
      );
      return inputData;
    },
    [availableNodes],
  );

  const _saveAgent = useCallback(async () => {
    //FIXME frontend ids should be resolved better (e.g. returned from the server)
    // currently this relays on block_id and position
    const blockIdToNodeIdMap: Record<string, string> = {};

    nodes.forEach((node) => {
      const key = `${node.data.block_id}_${node.position.x}_${node.position.y}`;
      blockIdToNodeIdMap[key] = node.id;
    });

    const formattedNodes = nodes.map((node) => {
      const inputDefault = prepareNodeInputData(node);
      const inputNodes = edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => ({
          name: edge.targetHandle || "",
          node_id: edge.source,
        }));

      const outputNodes = edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => ({
          name: edge.sourceHandle || "",
          node_id: edge.target,
        }));

      return {
        id: node.id,
        block_id: node.data.block_id,
        input_default: inputDefault,
        input_nodes: inputNodes,
        output_nodes: outputNodes,
        data: {
          ...node.data,
          hardcodedValues: removeEmptyStringsAndNulls(
            node.data.hardcodedValues,
          ),
        },
        metadata: { position: node.position },
      };
    });

    const links = edges.map((edge) => {
      let sourceName = edge.sourceHandle || "";
      const sourceNode = nodes.find((node) => node.id === edge.source);

      // Special case for SmartDecisionMakerBlock
      if (
        sourceNode?.data.block_id === SpecialBlockID.SMART_DECISION &&
        sourceName.toLowerCase() === "tools"
      ) {
        sourceName = `tools_^_${normalizeToolName(getToolFuncName(edge.target))}_~_${normalizeToolName(edge.targetHandle || "")}`;
      }
      return {
        source_id: edge.source,
        sink_id: edge.target,
        source_name: sourceName,
        sink_name: edge.targetHandle || "",
      };
    });

    const payload = {
      name: agentName || `New Agent ${new Date().toISOString()}`,
      description: agentDescription || "",
      nodes: formattedNodes,
      links: links,
    };

    // To avoid saving the same graph, we compare the payload with the saved agent.
    // Differences in IDs are ignored.
    const comparedPayload = {
      name: payload.name,
      description: payload.description,
      nodes: payload.nodes.map(
        ({ id: _, data: __, input_nodes: ___, output_nodes: ____, ...rest }) =>
          rest,
      ),
      links: payload.links.map(
        ({ source_id: _, sink_id: __, ...rest }) => rest,
      ),
    };
    const comparedSavedAgent = {
      name: savedAgent?.name,
      description: savedAgent?.description,
      nodes: savedAgent?.nodes.map((v) => ({
        block_id: v.block_id,
        input_default: v.input_default,
        metadata: v.metadata,
      })),
      links: savedAgent?.links.map((v) => ({
        sink_name: v.sink_name,
        source_name: v.source_name,
      })),
    };

    let newSavedAgent = null;
    if (savedAgent && deepEquals(comparedPayload, comparedSavedAgent)) {
      console.warn("No need to save: Graph is the same as version on server");
      newSavedAgent = savedAgent;
    } else {
      console.debug(
        "Saving new Graph version; old vs new:",
        comparedPayload,
        comparedSavedAgent,
      );
      setNodesSyncedWithSavedAgent(false);

      newSavedAgent = savedAgent
        ? await api.updateGraph(savedAgent.id, {
            ...payload,
            id: savedAgent.id,
          })
        : await api.createGraph(payload);

      console.debug("Response from the API:", newSavedAgent);
    }

    // Route the URL to the new flow ID if it's a new agent.
    if (!savedAgent) {
      const path = new URLSearchParams(searchParams);
      path.set("flowID", newSavedAgent.id);
      path.set("flowVersion", newSavedAgent.version.toString());
      router.push(`${pathname}?${path.toString()}`);
      return;
    }

    // Update the node IDs on the frontend
    setSavedAgent(newSavedAgent);
    setNodes((prev) => {
      return newSavedAgent.nodes
        .map((backendNode) => {
          const key = `${backendNode.block_id}_${backendNode.metadata.position.x}_${backendNode.metadata.position.y}`;
          const frontendNodeId = blockIdToNodeIdMap[key];
          const frontendNode = prev.find((node) => node.id === frontendNodeId);

          return frontendNode
            ? {
                ...frontendNode,
                position: backendNode.metadata.position,
                data: {
                  ...frontendNode.data,
                  hardcodedValues: removeEmptyStringsAndNulls(
                    frontendNode.data.hardcodedValues,
                  ),
                  status: undefined,
                  backend_id: backendNode.id,
                  webhook: backendNode.webhook,
                  executionResults: [],
                },
              }
            : null;
        })
        .filter((node) => node !== null);
    });
    // Reset bead count
    setEdges((edges) => {
      return edges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          edgeColor: edge.data?.edgeColor ?? "grey",
          beadUp: 0,
          beadDown: 0,
        },
      }));
    });
  }, [
    api,
    nodes,
    edges,
    pathname,
    router,
    searchParams,
    savedAgent,
    agentName,
    agentDescription,
    prepareNodeInputData,
  ]);

  const saveAgent = useCallback(async () => {
    try {
      await _saveAgent();
      completeStep("BUILDER_SAVE_AGENT");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Error saving agent", error);
      toast({
        variant: "destructive",
        title: "Error saving agent",
        description: errorMessage,
      });
      setSaveRunRequest({ request: "save", state: "error" });
    }
  }, [_saveAgent, toast]);

  const requestSave = useCallback(() => {
    if (saveRunRequest.state !== "none") {
      return;
    }
    saveAgent();
    setSaveRunRequest({
      request: "save",
      state: "saving",
    });
  }, [saveAgent, saveRunRequest.state]);

  const requestSaveAndRun = useCallback(() => {
    saveAgent();
    setSaveRunRequest({
      request: "run",
      state: "saving",
    });
  }, [saveAgent]);

  const requestStopRun = useCallback(() => {
    if (saveRunRequest.state != "running") {
      return;
    }
    if (!saveRunRequest.activeExecutionID) {
      console.warn(
        "Stop requested but execution ID is unknown; state:",
        saveRunRequest,
      );
    }
    setSaveRunRequest((prev) => ({
      ...prev,
      request: "stop",
      state: "running",
    }));
  }, [saveRunRequest]);

  // runs after saving cron expression and inputs (if exists)
  const scheduleRunner = useCallback(
    async (
      cronExpression: string,
      inputs: InputItem[],
      scheduleName: string,
    ) => {
      await saveAgent();
      try {
        if (flowID) {
          await api.createGraphExecutionSchedule({
            graph_id: flowID,
            // flowVersion is always defined here because scheduling is opened for a specific version
            graph_version: flowVersion!,
            name: scheduleName,
            cron: cronExpression,
            inputs: inputs.reduce(
              (acc, input) => ({
                ...acc,
                [input.hardcodedValues.name]: input.hardcodedValues.value,
              }),
              {},
            ),
          });
          toast({
            title: "Agent scheduling successful",
          });

          // if scheduling is done from the monitor page, then redirect to monitor page after successful scheduling
          if (searchParams.get("open_scheduling") === "true") {
            router.push("/");
          }
        } else {
          return;
        }
      } catch (error) {
        console.error(error);
        toast({
          variant: "destructive",
          title: "Error scheduling agent",
          description: "Please retry",
        });
      }
    },
    [api, flowID, saveAgent, toast, router, searchParams],
  );

  return {
    agentName,
    setAgentName,
    agentDescription,
    setAgentDescription,
    savedAgent,
    availableNodes,
    availableFlows,
    getOutputType,
    requestSave,
    requestSaveAndRun,
    requestStopRun,
    scheduleRunner,
    isSaving: saveRunRequest.state == "saving",
    isRunning: saveRunRequest.state == "running",
    isStopping: saveRunRequest.state == "stopping",
    isScheduling,
    setIsScheduling,
    nodes,
    setNodes,
    edges,
    setEdges,
  };
}
