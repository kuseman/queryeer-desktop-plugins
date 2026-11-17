package com.queryeer.plugin.jdbc.mysql;

/** MariaDB 11.8, the current long-term support release. */
class MariaDb118ContainerTest extends BaseMySqlContainerTest
{
    MariaDb118ContainerTest()
    {
        super("mariadb:11.8.9", "MARIADB", true);
    }
}
