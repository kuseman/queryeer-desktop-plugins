package com.queryeer.plugin.mongodb;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.queryeer.backend.api.FileSession;
import com.queryeer.backend.api.FileSessionHandler;

/**
 * Remembers the connection a file was bound to when the host opened its backend file session.
 *
 * <p>
 * This is only a fallback. The host opens the session once, when the file is first bound, so a later rebind is not seen here. The authoritative connection is
 * {@code engineState.connectionId}, which the frontend's execution-context provider attaches to every execution.
 * </p>
 */
final class FileConnections implements FileSessionHandler
{
    private final Map<String, String> connectionByFileId = new ConcurrentHashMap<>();

    @Override
    public String engineId()
    {
        return MongoBackendPlugin.ENGINE_ID;
    }

    @Override
    public void onOpen(FileSession session, String initialText)
    {
        if (session.connectionId() != null)
        {
            connectionByFileId.put(session.fileId(), session.connectionId());
        }
    }

    @Override
    public void onClose(FileSession session)
    {
        connectionByFileId.remove(session.fileId());
    }

    String connectionId(String fileId)
    {
        return fileId == null ? null
                : connectionByFileId.get(fileId);
    }
}
