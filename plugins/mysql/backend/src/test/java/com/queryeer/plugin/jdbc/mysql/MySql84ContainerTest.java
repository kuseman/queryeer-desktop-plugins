package com.queryeer.plugin.jdbc.mysql;

/** MySQL 8.4, the current long-term support release. */
class MySql84ContainerTest extends BaseMySqlContainerTest
{
    MySql84ContainerTest()
    {
        super("mysql:8.4.13", "MYSQL");
    }
}
