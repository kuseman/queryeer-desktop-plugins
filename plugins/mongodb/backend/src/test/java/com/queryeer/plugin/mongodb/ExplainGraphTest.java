package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.bson.BsonDocument;
import org.junit.jupiter.api.Test;

import com.queryeer.backend.contract.graph.GraphDocument;
import com.queryeer.backend.contract.graph.GraphProperty;
import com.queryeer.backend.contract.graph.GraphVertex;

/**
 * Explain replies captured from MongoDB 8.3 on the synthetic showcase database (scripts/seed-showcase.js), including slot-based (SBE) plans,
 * whose counts sit on low-level engine stages and are mapped onto the readable stages by planNodeId.
 */
class ExplainGraphTest
{
    private static GraphDocument graph(String fixture) throws IOException
    {
        try (InputStream in = ExplainGraphTest.class.getResourceAsStream("/explain/" + fixture + ".json"))
        {
            return ExplainGraph.convert(BsonDocument.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8)), "g", "Actual plan");
        }
    }

    private static GraphVertex vertex(GraphDocument graph, String label)
    {
        return graph.vertices()
                .stream()
                .filter(v -> label.equals(v.label()))
                .findFirst()
                .orElseThrow(() -> new AssertionError(label + " not in " + labels(graph)));
    }

    private static List<String> labels(GraphDocument graph)
    {
        return graph.vertices()
                .stream()
                .map(GraphVertex::label)
                .toList();
    }

    private static Object property(GraphVertex vertex, String id)
    {
        return vertex.properties()
                .stream()
                .flatMap(group -> group.properties()
                        .stream())
                .filter(p -> id.equals(p.id()))
                .map(GraphProperty::value)
                .findFirst()
                .orElse(null);
    }

    /** Sum of a count over all stages; must equal the server's totals, or stages are counted twice. */
    private static long total(GraphDocument graph, String id)
    {
        return graph.vertices()
                .stream()
                .map(v -> property(v, id))
                .filter(Long.class::isInstance)
                .mapToLong(Long.class::cast)
                .sum();
    }

    private static String consumerOf(GraphDocument graph, GraphVertex vertex)
    {
        return graph.edges()
                .stream()
                .filter(e -> e.sourceVertexId()
                        .equals(vertex.id()))
                .map(e -> graph.vertices()
                        .stream()
                        .filter(v -> v.id()
                                .equals(e.targetVertexId()))
                        .findFirst()
                        .orElseThrow()
                        .label())
                .findFirst()
                .orElse(null);
    }

    @Test
    void classicPlanUsesTheStagesWithTheirCounts() throws IOException
    {
        GraphDocument graph = graph("classicIndexSort");

        assertEquals(List.of("SORT", "FETCH", "IXSCAN"), labels(graph));
        assertEquals("open_status_partial", property(vertex(graph, "IXSCAN"), "index"));
        assertEquals(400L, property(vertex(graph, "IXSCAN"), "keysExamined"));
        assertEquals(400L, property(vertex(graph, "FETCH"), "docsExamined"));
        assertEquals("FETCH", consumerOf(graph, vertex(graph, "IXSCAN")));
        assertEquals("SORT", consumerOf(graph, vertex(graph, "FETCH")));
        assertEquals("400", graph.edges()
                .get(0)
                .label(), "edges carry the documents passed on");
        assertTrue(graph.description()
                .startsWith("Returned 400 · examined 400 documents and 400 index keys"), graph.description());
    }

    @Test
    void sbePlanMapsEngineCountsOntoReadableStagesAndChainsLaterPipelineStages() throws IOException
    {
        GraphDocument graph = graph("sbeGroupSort");

        assertEquals(List.of("GROUP", "FETCH", "IXSCAN", "$sort"), labels(graph));
        assertEquals(74L, property(vertex(graph, "GROUP"), "returned"), "from the topmost engine stage of the GROUP node");
        assertEquals(400L, property(vertex(graph, "FETCH"), "docsExamined"));
        assertEquals(400L, property(vertex(graph, "IXSCAN"), "keysExamined"));
        assertEquals("$sort", consumerOf(graph, vertex(graph, "GROUP")), "the $sort after $cursor consumes the group's output");
        assertEquals(74L, property(vertex(graph, "$sort"), "returned"));
        assertEquals(400L, total(graph, "docsExamined"));
        assertEquals(400L, total(graph, "keysExamined"));
    }

    @Test
    void sbeLookupCountsEachReadOnce() throws IOException
    {
        GraphDocument graph = graph("sbeLookup");

        assertEquals(List.of("EQ_LOOKUP", "FETCH", "IXSCAN"), labels(graph));
        GraphVertex lookup = vertex(graph, "EQ_LOOKUP");
        assertTrue(lookup.description()
                .startsWith("customers"), lookup.description());
        // The server's totals are 800 documents and 800 keys: half for the matches, half for the lookups
        assertEquals(800L, total(graph, "docsExamined"));
        assertEquals(800L, total(graph, "keysExamined"));
        assertEquals(400L, property(lookup, "docsExamined"));
        assertEquals(400L, property(lookup, "keysExamined"));
    }

    @Test
    void anEmptyReplyGivesAnEmptyGraphWithAReason()
    {
        GraphDocument graph = ExplainGraph.convert(BsonDocument.parse("{ ok: 1 }"), "g", "Plan");
        assertEquals(List.of(), graph.vertices());
        assertEquals("MongoDB returned no query plan for this command", graph.description());
    }
}
