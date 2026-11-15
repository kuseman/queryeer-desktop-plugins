package com.queryeer.plugin.mongodb;

/** MongoDB 8.3, the latest release. */
class Mongo83ContainerTest extends BaseMongoContainerTest
{
    Mongo83ContainerTest()
    {
        super("mongo:8.3.17");
    }
}
