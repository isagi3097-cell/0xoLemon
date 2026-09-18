using System.Text.Json;

namespace LuaSteamKit;

// Private parent/child protocol. These types are never forwarded to the WebView.
public sealed class WorkshopRequest
{
    public required string RequestId { get; init; }
    public required string Operation { get; init; }
    public string? AccountName { get; init; }
    public string? RefreshToken { get; init; }
    public ulong SteamId { get; init; }
    public uint AppId { get; init; }
    public ulong ItemId { get; init; }
}

public static class WorkshopProtocol
{
    public const int MaximumFrameBytes = 16 * 1024;
    public static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static bool IsVersionTwo(byte[] bytes)
    {
        using var json = JsonDocument.Parse(bytes);
        return json.RootElement.ValueKind == JsonValueKind.Object &&
            json.RootElement.TryGetProperty("schemaVersion", out var version) && version.TryGetInt32(out var v) && v == 2;
    }

    public static WorkshopRequest Parse(byte[] bytes)
    {
        try
        {
            if (bytes.Length > MaximumFrameBytes) throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID");
            using var json = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 4 });
            var root = json.RootElement;
            var operation = root.GetProperty("operation").GetString();
            var allowed = operation switch
            {
                "qrLogin" => new[] { "schemaVersion", "requestId", "operation" },
                "workshopDetails" => new[] { "schemaVersion", "requestId", "operation", "accountName", "refreshToken", "steamId", "appid", "itemId" },
                _ => throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID")
            };
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
                if (!allowed.Contains(property.Name) || !seen.Add(property.Name)) throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID");
            var id = root.GetProperty("requestId").GetString();
            if (root.GetProperty("schemaVersion").GetInt32() != 2 || id is null || id.Length is < 1 or > 96 ||
                id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.' and not ':'))
                throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID");
            if (operation == "qrLogin") return new WorkshopRequest { RequestId = id, Operation = operation };
            var name = root.GetProperty("accountName").GetString();
            var token = root.GetProperty("refreshToken").GetString();
            if (name is null || name.Length is < 1 or > 128 || name.Any(char.IsControl) ||
                token is null || token.Length is < 16 or > 8192 || token.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '.' and not '-' and not '_') ||
                !ulong.TryParse(root.GetProperty("steamId").GetString(), out var steamId) || steamId == 0 ||
                !ulong.TryParse(root.GetProperty("itemId").GetString(), out var itemId) || itemId == 0 ||
                !root.GetProperty("appid").TryGetUInt32(out var appId) || appId == 0)
                throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID");
            return new WorkshopRequest { RequestId = id, Operation = operation!, AccountName = name, RefreshToken = token, SteamId = steamId, AppId = appId, ItemId = itemId };
        }
        catch (ProtocolException) { throw; }
        catch { throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID"); }
    }

    public static bool ValidChallenge(string url) => url.Length <= 1024 && Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.Host == "s.team" && uri.Port == 443 && uri.UserInfo.Length == 0 &&
        uri.AbsolutePath.StartsWith("/q/", StringComparison.Ordinal) && uri.Query.Length == 0 && uri.Fragment.Length == 0;

    public static void WriteFrame(Stream output, object frame)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame, JsonOptions);
        try
        {
            if (bytes.Length > MaximumFrameBytes) throw new ProtocolException("LUA_STEAM_AUTH_PROTOCOL_INVALID");
            lock (output) { output.Write(bytes); output.WriteByte((byte)'\n'); output.Flush(); }
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); }
    }
}
