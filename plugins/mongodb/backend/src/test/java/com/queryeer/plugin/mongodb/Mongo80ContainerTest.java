package com.queryeer.plugin.mongodb;

/** MongoDB 8.0, the current long-term support release. */
class Mongo80ContainerTest extends BaseMongoContainerTest
{
    Mongo80ContainerTest()
    {
        super("mongo:8.0.26");
    }
}
