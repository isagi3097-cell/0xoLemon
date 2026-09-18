using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using SteamKit2;

namespace LuaSteamKit;

public sealed record Request(string RequestId, uint AppId);

public sealed record Response(
    int SchemaVersion,
    string RequestId,
    bool Success,
    string Source,
    uint AppId,
    Dictionary<string, object?>? AppInfo = null,
    string? ErrorCode = null,
    uint? ChangeNumber = null)
{
    public static Response Error(string requestId, uint appId, string code) => new(1, requestId, false, "steamKit", appId, ErrorCode: code);
}

public sealed class ProtocolException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public static class Protocol
{
    public const int MaximumRequestBytes = 4096;
    public const int MaximumResponseBytes = 2 * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        MaxDepth = 64,
    };

    public static Request Parse(ReadOnlyMemory<byte> bytes)
    {
        if (bytes.Length is 0 or > MaximumRequestBytes) throw new ProtocolException("INVALID_REQUEST_SIZE");
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new ProtocolException("INVALID_REQUEST");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
            {
                if (!seen.Add(property.Name) || property.Name is not ("schemaVersion" or "requestId" or "operation" or "appid"))
                    throw new ProtocolException("INVALID_REQUEST_FIELDS");
            }
            if (!root.TryGetProperty("schemaVersion", out var schema) || !schema.TryGetInt32(out var version) || version != 1)
                throw new ProtocolException("UNSUPPORTED_SCHEMA");
            if (!root.TryGetProperty("requestId", out var id) || id.ValueKind != JsonValueKind.String || !ValidRequestId(id.GetString()))
                throw new ProtocolException("INVALID_REQUEST_ID");
            if (!root.TryGetProperty("operation", out var operation) || operation.ValueKind != JsonValueKind.String || operation.GetString() != "appInfo")
                throw new ProtocolException("UNSUPPORTED_OPERATION");
            if (!root.TryGetProperty("appid", out var app) || !app.TryGetUInt32(out var appId) || appId == 0)
                throw new ProtocolException("INVALID_APPID");
            return new Request(id.GetString()!, appId);
        }
        catch (JsonException) { throw new ProtocolException("INVALID_JSON"); }
        catch (InvalidOperationException) { throw new ProtocolException("INVALID_REQUEST_TYPES"); }
    }

    private static bool ValidRequestId(string? value) => value is { Length: >= 1 and <= 96 }
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-');

    public static async Task<byte[]> ReadRequestAsync(Stream input, CancellationToken cancellation, int maximumBytes = MaximumRequestBytes)
    {
        using var output = new MemoryStream();
        var buffer = new byte[512];
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellation).ConfigureAwait(false);
            if (read == 0) break;
            var newline = Array.IndexOf(buffer, (byte)'\n', 0, read);
            var length = newline >= 0 ? newline : read;
            if (output.Length + length > maximumBytes) throw new ProtocolException("INVALID_REQUEST_SIZE");
            output.Write(buffer, 0, length);
            if (newline >= 0) break;
        }
        return output.ToArray();
    }

    public static byte[] Encode(Response response) => EncodeOutcome(response).Bytes;

    public static (byte[] Bytes, int ExitCode) EncodeOutcome(Response response)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions);
        if (bytes.Length <= MaximumResponseBytes) return (bytes, response.Success ? 0 : 2);
        // The emitted failure, not the original success object, owns the process outcome.
        return (JsonSerializer.SerializeToUtf8Bytes(Response.Error(response.RequestId, response.AppId, "APPINFO_TOO_LARGE"), JsonOptions), 2);
    }

    public static Dictionary<string, object?> ConvertKeyValues(KeyValue root)
    {
        var budget = new ConversionBudget();
        return ConvertChildren(root, budget, 0);
    }

    private sealed class ConversionBudget { public int Nodes; public int TextBytes; }

    private static Dictionary<string, object?> ConvertChildren(KeyValue parent, ConversionBudget budget, int depth)
    {
        if (depth > 32) throw new ProtocolException("APPINFO_DEPTH_LIMIT");
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var child in parent.Children)
        {
            if (++budget.Nodes > 50_000) throw new ProtocolException("APPINFO_NODE_LIMIT");
            var name = child.Name ?? string.Empty;
            if (name.Length is 0 or > 1024) throw new ProtocolException("APPINFO_INVALID_KEY");
            budget.TextBytes += Encoding.UTF8.GetByteCount(name);
            object? value;
            if (child.Children.Count > 0) value = ConvertChildren(child, budget, depth + 1);
            else
            {
                value = child.Value ?? string.Empty;
                budget.TextBytes += Encoding.UTF8.GetByteCount((string)value);
            }
            if (budget.TextBytes > 1024 * 1024) throw new ProtocolException("APPINFO_TOO_LARGE");
            // VDF permits repeated names; preserve them instead of silently discarding metadata.
            if (result.TryGetValue(name, out var previous))
            {
                if (previous is List<object?> duplicates) duplicates.Add(value);
                else result[name] = new List<object?> { previous, value };
            }
            else result[name] = value;
        }
        return result;
    }
}
