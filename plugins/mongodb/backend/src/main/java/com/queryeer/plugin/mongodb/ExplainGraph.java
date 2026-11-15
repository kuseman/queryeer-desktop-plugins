package com.queryeer.plugin.mongodb;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import org.bson.BsonArray;
import org.bson.BsonDocument;
import org.bson.BsonValue;

import com.queryeer.backend.contract.graph.GraphDocument;
import com.queryeer.backend.contract.graph.GraphEdge;
import com.queryeer.backend.contract.graph.GraphEdgeStyle;
import com.queryeer.backend.contract.graph.GraphLayoutOptions;
import com.queryeer.backend.contract.graph.GraphProperty;
import com.queryeer.backend.contract.graph.GraphPropertyGroup;
import com.queryeer.backend.contract.graph.GraphVertex;
import com.queryeer.backend.contract.graph.GraphVertexOverlay;
import com.queryeer.backend.contract.graph.GraphVertexStyle;

/**
 * Turns the reply of an {@code explain} command into a plan graph for the host's Plan output (the same {@code GraphDocument} shape the Postgres
 * dialect produces): one vertex per plan stage, edges from each stage to the stage that consumes its output.
 *
 * <p>
 * Handles the shapes MongoDB returns:
 * </p>
 * <ul>
 * <li>Classic plans: {@code queryPlanner.winningPlan} is the stage tree; with {@code executionStats}, {@code executionStages} is the same tree with
 * per-stage counts, so that tree is drawn.</li>
 * <li>Slot-based (SBE) plans: {@code winningPlan.queryPlan} is the readable tree; {@code executionStages} holds low-level engine stages, whose counts are
 * mapped back onto the readable stages by {@code planNodeId}.</li>
 * <li>Aggregations split into {@code stages: [{ $cursor }, { $sort }, ...]}: the {@code $cursor} plan, followed by one vertex per later stage.</li>
 * <li>Sharded plans: {@code shards[]} under the merge stage, one subtree per shard.</li>
 * </ul>
 */
final class ExplainGraph
{
    private static final Set<String> CHILD_KEYS = Set.of("inputStage", "inputStages", "outerStage", "innerStage", "thenStage", "elseStage");
    private static final int MAX_TEXT = 400;
    /** SBE stages whose {@code numReads} counts documents read from the collection. */
    private static final Set<String> SBE_DOCUMENT_READS = Set.of("fetch", "scan", "seek");

    private final List<GraphVertex> vertices = new ArrayList<>();
    private final List<GraphEdge> edges = new ArrayList<>();
    private final List<Draft> drafts = new ArrayList<>();
    private Map<Integer, Stats> sbeStats = Map.of();
    private int counter;

    /** One stage before styling: styles depend on the share of work across all stages. */
    private record Draft(String id, String stage, String description, List<GraphPropertyGroup> groups, List<GraphVertexOverlay> overlays, Stats stats)
    {
    }

    /** Per-stage counts from executionStats; all null for an estimated plan. */
    private record Stats(Long returned, Long docsExamined, Long keysExamined, Long millis)
    {
        static final Stats NONE = new Stats(null, null, null, null);

        long work()
        {
            return (docsExamined == null ? 0
                    : docsExamined)
                    + (keysExamined == null ? 0
                            : keysExamined);
        }
    }

    private ExplainGraph()
    {
    }

    static GraphDocument convert(BsonDocument explain, String graphId, String title)
    {
        return new ExplainGraph().build(explain, graphId, title);
    }

    private GraphDocument build(BsonDocument explain, String graphId, String title)
    {
        BsonDocument cursorPart = explain;
        List<BsonDocument> laterStages = new ArrayList<>();
        BsonArray stages = explain.getArray("stages", null);
        if (stages != null
                && !stages.isEmpty()
                && stages.get(0)
                        .isDocument())
        {
            BsonDocument first = stages.get(0)
                    .asDocument();
            cursorPart = first.containsKey("$cursor") ? first.getDocument("$cursor")
                    : first;
            for (int i = 1; i < stages.size(); i++)
            {
                if (stages.get(i)
                        .isDocument())
                {
                    laterStages.add(stages.get(i)
                            .asDocument());
                }
            }
        }

        BsonDocument queryPlanner = document(cursorPart, "queryPlanner");
        BsonDocument executionStats = document(cursorPart, "executionStats");
        BsonDocument winningPlan = document(queryPlanner, "winningPlan");
        if (winningPlan == null)
        {
            return new GraphDocument(graphId, title, "MongoDB returned no query plan for this command", layout(), List.of(), List.of());
        }

        BsonDocument executionStages = document(executionStats, "executionStages");
        String root;
        if (winningPlan.containsKey("queryPlan"))
        {
            // SBE: draw the readable tree, with counts from the engine stages that carry its planNodeIds
            sbeStats = executionStages == null ? Map.of()
                    : sbeStatsByPlanNode(executionStages);
            root = appendStage(winningPlan.getDocument("queryPlan"), null);
        }
        else
        {
            root = appendStage(executionStages != null ? executionStages
                    : winningPlan, null);
        }

        // Pipeline stages after $cursor consume its output, one after another
        for (BsonDocument stage : laterStages)
        {
            root = appendPipelineStage(stage, root);
        }

        finishVertices();
        return new GraphDocument(graphId, title, summary(queryPlanner, executionStats), layout(), vertices, edges);
    }

    /** Adds the stage and its inputs; returns its vertex id. */
    private String appendStage(BsonDocument stage, String consumerId)
    {
        String id = "s" + (++counter);
        String name = text(stage, "stage", "PLAN");
        Stats stats = stats(stage);
        drafts.add(new Draft(id, name, describe(name, stage), details(name, stage, stats), overlays(name, stage), stats));
        if (consumerId != null)
        {
            edges.add(edge(id, consumerId, stats));
        }
        for (BsonDocument child : children(stage))
        {
            appendStage(child, id);
        }
        return id;
    }

    private String appendPipelineStage(BsonDocument stage, String inputId)
    {
        String name = stage.keySet()
                .stream()
                .filter(key -> key.startsWith("$"))
                .findFirst()
                .orElse("stage");
        String id = "s" + (++counter);
        Stats stats = new Stats(number(stage, "nReturned"), null, null, number(stage, "executionTimeMillisEstimate"));
        List<GraphPropertyGroup> groups = new ArrayList<>();
        List<GraphProperty> details = new ArrayList<>();
        add(details, "spec", "Stage", json(stage.get(name)), false);
        addGroup(groups, "details", "Details", details);
        addGroup(groups, "execution", "Execution", execution(stats));
        drafts.add(new Draft(id, name, abbreviate(json(stage.get(name)), 80), groups, List.of(), stats));
        edges.add(edge(inputId, id, stageStats(inputId)));
        return id;
    }

    private Stats stageStats(String id)
    {
        return drafts.stream()
                .filter(draft -> draft.id()
                        .equals(id))
                .map(Draft::stats)
                .findFirst()
                .orElse(Stats.NONE);
    }

    /** Inputs of a stage: classic and readable SBE trees use inputStage(s); merge stages of sharded plans list shards. */
    private static List<BsonDocument> children(BsonDocument stage)
    {
        List<BsonDocument> children = new ArrayList<>();
        for (String key : CHILD_KEYS)
        {
            BsonValue value = stage.get(key);
            if (value != null
                    && value.isDocument())
            {
                children.add(value.asDocument());
            }
            else if (value != null
                    && value.isArray())
            {
                value.asArray()
                        .stream()
                        .filter(BsonValue::isDocument)
                        .forEach(item -> children.add(item.asDocument()));
            }
        }
        BsonArray shards = stage.getArray("shards", null);
        if (shards != null)
        {
            for (BsonValue shard : shards)
            {
                if (!shard.isDocument())
                {
                    continue;
                }
                BsonDocument shardDocument = shard.asDocument();
                BsonDocument plan = document(shardDocument, "executionStages");
                BsonDocument winning = document(shardDocument, "winningPlan");
                if (plan == null
                        && winning != null)
                {
                    plan = winning.containsKey("queryPlan") ? winning.getDocument("queryPlan")
                            : winning;
                }
                if (plan != null)
                {
                    BsonDocument labelled = plan.clone();
                    if (shardDocument.containsKey("shardName"))
                    {
                        labelled.put("shardName", shardDocument.get("shardName"));
                    }
                    children.add(labelled);
                }
            }
        }
        return children;
    }

    private Stats stats(BsonDocument stage)
    {
        if (stage.containsKey("planNodeId")
                && !sbeStats.isEmpty())
        {
            return sbeStats.getOrDefault(stage.getNumber("planNodeId")
                    .intValue(), Stats.NONE);
        }
        Long docs = number(stage, "docsExamined");
        if (docs == null
                && "COLLSCAN".equals(text(stage, "stage", "")))
        {
            docs = number(stage, "nReturned");
        }
        return new Stats(number(stage, "nReturned"), docs, number(stage, "keysExamined"), number(stage, "executionTimeMillisEstimate"));
    }

    /** For SBE: the topmost engine stage of each plan node gives its output; documents and keys examined are summed over its stages. */
    private static Map<Integer, Stats> sbeStatsByPlanNode(BsonDocument executionStages)
    {
        Map<Integer, Stats> result = new HashMap<>();
        collectSbe(executionStages, result);
        return result;
    }

    private static void collectSbe(BsonDocument stage, Map<Integer, Stats> result)
    {
        if (stage.containsKey("planNodeId")
                && stage.get("planNodeId")
                        .isNumber())
        {
            int planNodeId = stage.getNumber("planNodeId")
                    .intValue();
            // Only the leaf counters: nlj stages repeat their whole subtree's totals (totalDocsExamined/totalKeysExamined), which would count twice
            String engineStage = text(stage, "stage", "");
            Long docs = SBE_DOCUMENT_READS.contains(engineStage) ? number(stage, "numReads")
                    : null;
            Long keys = number(stage, "keysExamined");
            Stats existing = result.get(planNodeId);
            if (existing == null)
            {
                result.put(planNodeId, new Stats(number(stage, "nReturned"), docs, keys, number(stage, "executionTimeMillisEstimate")));
            }
            else if (docs != null
                    || keys != null)
            {
                result.put(planNodeId, new Stats(existing.returned(), sum(existing.docsExamined(), docs), sum(existing.keysExamined(), keys), existing.millis()));
            }
        }
        for (BsonValue value : stage.values())
        {
            if (value.isDocument()
                    && value.asDocument()
                            .containsKey("stage"))
            {
                collectSbe(value.asDocument(), result);
            }
            else if (value.isArray())
            {
                value.asArray()
                        .stream()
                        .filter(item -> item.isDocument()
                                && item.asDocument()
                                        .containsKey("stage"))
                        .forEach(item -> collectSbe(item.asDocument(), result));
            }
        }
    }

    /** A one-line summary under the stage name. */
    private static String describe(String name, BsonDocument stage)
    {
        String shard = text(stage, "shardName", null);
        String summary = switch (name)
        {
            case "IXSCAN", "COUNT_SCAN", "DISTINCT_SCAN", "EXPRESS_IXSCAN" -> text(stage, "indexName", "");
            case "COLLSCAN" -> "Every document in " + collection(text(stage, "nss", "the collection"));
            case "FETCH" -> stage.containsKey("filter") ? "Filter: " + abbreviate(json(stage.get("filter")), 60)
                    : "";
            case "SORT" -> stage.containsKey("sortPattern") ? json(stage.get("sortPattern")) + (stage.getBoolean("usedDisk", org.bson.BsonBoolean.FALSE)
                    .getValue() ? " (used disk)"
                            : "")
                    : "";
            case "EQ_LOOKUP" -> collection(text(stage, "foreignCollection", "")) + " (" + text(stage, "strategy", "") + ")";
            case "LIMIT" -> stage.containsKey("limitAmount") ? "Limit " + stage.get("limitAmount")
                    .asNumber()
                    .longValue()
                    : "";
            case "SKIP" -> stage.containsKey("skipAmount") ? "Skip " + stage.get("skipAmount")
                    .asNumber()
                    .longValue()
                    : "";
            case "PROJECTION_SIMPLE", "PROJECTION_DEFAULT", "PROJECTION_COVERED" -> stage.containsKey("transformBy") ? abbreviate(json(stage.get("transformBy")), 60)
                    : "";
            default -> "";
        };
        return shard == null ? summary
                : summary.isEmpty() ? "Shard " + shard
                        : "Shard " + shard + ": " + summary;
    }

    private static List<GraphPropertyGroup> details(String name, BsonDocument stage, Stats stats)
    {
        List<GraphPropertyGroup> groups = new ArrayList<>();
        addGroup(groups, "execution", "Execution", execution(stats));
        List<GraphProperty> details = new ArrayList<>();
        add(details, "stage", "Stage", name, false);
        add(details, "shard", "Shard", text(stage, "shardName", null), false);
        add(details, "namespace", "Namespace", text(stage, "nss", null), false);
        add(details, "index", "Index", text(stage, "indexName", null), "IXSCAN".equals(name));
        if (stage.containsKey("keyPattern"))
        {
            add(details, "keyPattern", "Key pattern", json(stage.get("keyPattern")), false);
        }
        if (stage.containsKey("indexBounds"))
        {
            add(details, "indexBounds", "Index bounds", json(stage.get("indexBounds")), false);
        }
        add(details, "direction", "Direction", text(stage, "direction", null), false);
        if (stage.containsKey("isMultiKey"))
        {
            add(details, "multiKey", "Multikey index", String.valueOf(stage.getBoolean("isMultiKey")
                    .getValue()), false);
        }
        if (stage.containsKey("filter"))
        {
            add(details, "filter", "Filter", json(stage.get("filter")), true);
        }
        if (stage.containsKey("sortPattern"))
        {
            add(details, "sortPattern", "Sort", json(stage.get("sortPattern")), true);
        }
        for (String key : List.of("usedDisk", "spills", "totalDataSizeSorted", "memLimit", "foreignCollection", "localField", "foreignField", "asField", "strategy"))
        {
            BsonValue value = stage.get(key);
            if (value != null)
            {
                add(details, key, label(key), value.isNumber() ? value.asNumber()
                        .longValue()
                        : value.isString() ? value.asString()
                                .getValue()
                                : json(value), "usedDisk".equals(key)
                                        && value.isBoolean()
                                        && value.asBoolean()
                                                .getValue());
            }
        }
        addGroup(groups, "details", "Details", details);
        return groups;
    }

    private static List<GraphProperty> execution(Stats stats)
    {
        List<GraphProperty> execution = new ArrayList<>();
        add(execution, "returned", "Returned", stats.returned(), true);
        add(execution, "docsExamined", "Documents examined", stats.docsExamined(), true);
        add(execution, "keysExamined", "Index keys examined", stats.keysExamined(), true);
        if (stats.millis() != null)
        {
            execution.add(new GraphProperty("time", "Time (estimate)", stats.millis(), "ms", false));
        }
        return execution;
    }

    private static List<GraphVertexOverlay> overlays(String name, BsonDocument stage)
    {
        List<GraphVertexOverlay> overlays = new ArrayList<>();
        if ("COLLSCAN".equals(name))
        {
            overlays.add(new GraphVertexOverlay("collscan", "warning", "Collection scan", "Reads every document: no index supports this query", null));
        }
        if (stage.getBoolean("usedDisk", org.bson.BsonBoolean.FALSE)
                .getValue())
        {
            overlays.add(new GraphVertexOverlay("usedDisk", "warning", "Used disk", "The stage ran out of memory and spilled to disk", null));
        }
        return overlays;
    }

    /** Styles by each stage's share of the documents and keys examined; a collection scan is always marked. */
    private void finishVertices()
    {
        long total = drafts.stream()
                .mapToLong(draft -> draft.stats()
                        .work())
                .sum();
        for (Draft draft : drafts)
        {
            double share = total <= 0 ? 0
                    : 100.0 * draft.stats()
                            .work() / total;
            String description = draft.description();
            if (total > 0
                    && share >= 1)
            {
                description = (description.isEmpty() ? ""
                        : description + " · ") + Math.round(share) + "% of examined";
            }
            vertices.add(new GraphVertex(draft.id(), draft.stage(), kind(draft.stage()), description, style("COLLSCAN".equals(draft.stage()) ? Math.max(share, 50)
                    : share), draft.groups(), draft.overlays(), List.of()));
        }
    }

    private static GraphEdge edge(String sourceId, String targetId, Stats source)
    {
        String label = source.returned() == null ? null
                : format(source.returned());
        List<GraphPropertyGroup> groups = source.returned() == null ? List.of()
                : List.of(new GraphPropertyGroup("rows", "Documents", List.of(new GraphProperty("returned", "Returned", source.returned(), null, true))));
        double width = source.returned() == null ? 2
                : 1.5 + Math.min(5.5, Math.log10(source.returned() + 1));
        return new GraphEdge(sourceId + "-" + targetId, sourceId, targetId, label, "input", new GraphEdgeStyle("smoothstep", "#93c5fd", width, false, "arrow"), groups,
                List.of());
    }

    private static String summary(BsonDocument queryPlanner, BsonDocument executionStats)
    {
        List<String> parts = new ArrayList<>();
        if (executionStats != null)
        {
            Long returned = number(executionStats, "nReturned");
            Long docs = number(executionStats, "totalDocsExamined");
            Long keys = number(executionStats, "totalKeysExamined");
            Long millis = number(executionStats, "executionTimeMillis");
            if (returned != null)
            {
                parts.add("Returned " + format(returned));
            }
            if (docs != null
                    || keys != null)
            {
                parts.add("examined " + format(docs == null ? 0
                        : docs) + " documents and " + format(keys == null ? 0
                                : keys) + " index keys");
            }
            if (millis != null)
            {
                parts.add(millis + " ms");
            }
        }
        else
        {
            parts.add("Estimated: the query was not run");
        }
        BsonArray rejected = queryPlanner == null ? null
                : queryPlanner.getArray("rejectedPlans", null);
        if (rejected != null
                && !rejected.isEmpty())
        {
            parts.add(rejected.size() + (rejected.size() == 1 ? " other plan was" : " other plans were") + " considered");
        }
        return String.join(" · ", parts);
    }

    private static String kind(String stage)
    {
        return switch (stage)
        {
            case "COLLSCAN", "IXSCAN", "COUNT_SCAN", "DISTINCT_SCAN", "EXPRESS_IXSCAN", "EXPRESS_CLUSTERED_IXSCAN", "CLUSTERED_IXSCAN", "TEXT_MATCH", "GEO_NEAR_2D",
                    "GEO_NEAR_2DSPHERE", "IDHACK", "EXPRESS_IDHACK" -> "Scan";
            case "SORT", "SORT_KEY_GENERATOR", "SORT_MERGE", "$sort" -> "Sort";
            case "GROUP", "COUNT", "$group", "$count", "$bucket", "$bucketAuto" -> "Aggregate";
            case "EQ_LOOKUP", "$lookup", "$graphLookup", "$unionWith", "OR", "AND_HASH", "AND_SORTED" -> "Join";
            case "LIMIT", "SKIP", "$limit", "$skip" -> "Limit";
            case "SHARD_MERGE", "SHARD_MERGE_SORT", "SINGLE_SHARD", "SHARDING_FILTER" -> "Parallelism";
            default -> "operator";
        };
    }

    private static GraphVertexStyle style(double share)
    {
        if (share >= 50)
        {
            return new GraphVertexStyle("rounded", null, "#7f1d1d", "#f87171", null, null, 210, 86);
        }
        if (share >= 20)
        {
            return new GraphVertexStyle("rounded", null, "#7c2d12", "#fb923c", null, null, 210, 86);
        }
        if (share >= 5)
        {
            return new GraphVertexStyle("rounded", null, "#713f12", "#facc15", null, null, 210, 86);
        }
        return new GraphVertexStyle("rounded", null, "#1e3a8a", "#60a5fa", null, null, 210, 86);
    }

    private static GraphLayoutOptions layout()
    {
        return new GraphLayoutOptions("right-left", 110, 80);
    }

    private static String label(String key)
    {
        String spaced = key.replaceAll("([a-z])([A-Z])", "$1 $2")
                .toLowerCase(Locale.ROOT);
        return Character.toUpperCase(spaced.charAt(0)) + spaced.substring(1);
    }

    private static void addGroup(List<GraphPropertyGroup> groups, String id, String label, List<GraphProperty> properties)
    {
        if (!properties.isEmpty())
        {
            groups.add(new GraphPropertyGroup(id, label, properties));
        }
    }

    private static void add(List<GraphProperty> properties, String id, String label, Object value, boolean important)
    {
        if (value != null
                && !"".equals(value))
        {
            properties.add(new GraphProperty(id, label, value instanceof String text ? abbreviate(text, MAX_TEXT)
                    : value, null, important));
        }
    }

    private static BsonDocument document(BsonDocument parent, String key)
    {
        if (parent == null)
        {
            return null;
        }
        BsonValue value = parent.get(key);
        return value != null
                && value.isDocument() ? value.asDocument()
                        : null;
    }

    private static String text(BsonDocument document, String key, String fallback)
    {
        BsonValue value = document.get(key);
        return value != null
                && value.isString() ? value.asString()
                        .getValue()
                        : fallback;
    }

    private static Long number(BsonDocument document, String key)
    {
        if (document == null)
        {
            return null;
        }
        BsonValue value = document.get(key);
        return value != null
                && value.isNumber() ? value.asNumber()
                        .longValue()
                        : null;
    }

    private static Long sum(Long a, Long b)
    {
        // Not one conditional expression: mixing Long and long there would unbox a null
        if (a == null)
        {
            return b;
        }
        if (b == null)
        {
            return a;
        }
        return Long.valueOf(a + b);
    }

    private static String json(BsonValue value)
    {
        return value == null ? ""
                : ValueMapper.json(value);
    }

    /** "shop.reports.monthly" → "reports.monthly": the collection part of a namespace (database names have no dots). */
    private static String collection(String namespace)
    {
        int dot = namespace.indexOf('.');
        return dot < 0 ? namespace
                : namespace.substring(dot + 1);
    }

    private static String abbreviate(String text, int max)
    {
        return text.length() <= max ? text
                : text.substring(0, max - 1) + "…";
    }

    private static String format(long value)
    {
        return String.format(Locale.ROOT, "%,d", value);
    }
}
