package com.queryeer.plugin.mongodb;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MongoBackendPluginTest
{
    @Test
    void packagesTheGeneratedChangelog()
    {
        String changelog = MongoBackendPlugin.changelog();
        assertNotNull(changelog, "CHANGELOG.md is not on the classpath; check generate-changelog in pom.xml");
        assertTrue(changelog.startsWith("# MongoDB"), changelog);
        assertTrue(changelog.contains("\n## v"), "No release section: " + changelog);
    }
}
