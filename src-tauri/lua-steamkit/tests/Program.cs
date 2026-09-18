using System.Text;
using System.Text.Json;
using LuaSteamKit;
using SteamKit2;

static void Assert(bool value, string name) { if (!value) throw new Exception(name); }
static byte[] Bytes(string value) => Encoding.UTF8.GetBytes(value);
static void Rejected(string value) { try { Protocol.Parse(Bytes(value)); throw new Exception("invalid request accepted"); } catch (ProtocolException) { } }

var request = Protocol.Parse(Bytes("{\"schemaVersion\":1,\"requestId\":\"unit-1\",\"operation\":\"appInfo\",\"appid\":2067920}"));
Assert(request.AppId == 2067920 && request.RequestId == "unit-1", "request identity");
foreach (var input in new[] { "{}", "[]", "not-json", "{\"schemaVersion\":1,\"schemaVersion\":1}",
    "{\"schemaVersion\":1,\"requestId\":\"safe\",\"operation\":\"login\",\"appid\":480}",
    "{\"schemaVersion\":1,\"requestId\":\"safe\",\"operation\":\"appInfo\",\"appid\":0}",
    "{\"schemaVersion\":1,\"requestId\":\"safe\",\"operation\":\"appInfo\",\"appid\":480,\"token\":\"never-accepted\"}",
    "{\"schemaVersion\":1,\"requestId\":\"secret with spaces\",\"operation\":\"appInfo\",\"appid\":480}" }) Rejected(input);
Rejected(new string(' ', 4097));
var framed = await Protocol.ReadRequestAsync(new MemoryStream(Bytes("one\nignored-second-line")), CancellationToken.None);
Assert(Encoding.UTF8.GetString(framed) == "one", "one line only");
var root = new KeyValue("appinfo");
root.Children.Add(new KeyValue("appid", "2067920"));
var common = new KeyValue("common"); common.Children.Add(new KeyValue("name", "Fixture")); root.Children.Add(common);
root.Children.Add(new KeyValue("duplicate", "A")); root.Children.Add(new KeyValue("duplicate", "B"));
var converted = Protocol.ConvertKeyValues(root);
Assert((string)converted["appid"]! == "2067920", "appid scalar");
Assert(converted["common"] is Dictionary<string, object?>, "nested objects");
Assert(converted["duplicate"] is List<object?> duplicates && duplicates.Count == 2, "duplicate preservation");
using (var response = JsonDocument.Parse(Protocol.Encode(new Response(1, "unit-1", true, "steamKit", 2067920, converted, ChangeNumber: 42))))
{
    Assert(response.RootElement.GetProperty("requestId").GetString() == "unit-1", "response echo");
    Assert(response.RootElement.GetProperty("source").GetString() == "steamKit", "native source");
    Assert(response.RootElement.GetProperty("appInfo").GetProperty("common").GetProperty("name").GetString() == "Fixture", "response nested");
}
var tooLarge = new Dictionary<string, object?> { ["large"] = new string('x', Protocol.MaximumResponseBytes) };
var limitedOutcome = Protocol.EncodeOutcome(new Response(1,"limit",true,"steamKit",480,tooLarge));
Assert(limitedOutcome.ExitCode == 2, "oversized success must exit as emitted failure");
using (var limited = JsonDocument.Parse(limitedOutcome.Bytes))
{
    Assert(limited.RootElement.GetProperty("errorCode").GetString() == "APPINFO_TOO_LARGE", "bounded output");
    Assert(!limited.RootElement.GetProperty("success").GetBoolean(), "oversized envelope failure");
    Assert(limited.RootElement.GetProperty("requestId").GetString() == "limit", "oversized identity retained");
}
Assert(Protocol.EncodeOutcome(new Response(1,"ok",true,"steamKit",480,converted)).ExitCode == 0, "ordinary success exit");
Assert(Protocol.EncodeOutcome(Response.Error("failed",480,"PICS_TIMEOUT")).ExitCode == 2, "ordinary typed failure exit");
Console.WriteLine("PASS protocol validation, unknown/auth fields, framing, recursive VDF, duplicate preservation, identity, output bound and emitted-envelope exit codes");
var qr = WorkshopProtocol.Parse(Bytes("{\"schemaVersion\":2,\"requestId\":\"qr-1\",\"operation\":\"qrLogin\"}"));
Assert(qr.Operation == "qrLogin" && qr.RefreshToken is null, "QR never accepts credentials from UI");
foreach (var invalid in new[] {
    "{\"schemaVersion\":2,\"requestId\":\"qr-1\",\"operation\":\"qrLogin\",\"password\":\"no\"}",
    "{\"schemaVersion\":2,\"requestId\":\"qr-1\",\"requestId\":\"qr-2\",\"operation\":\"qrLogin\"}",
    "{\"schemaVersion\":2,\"requestId\":\"qr-1\",\"operation\":\"workshopDetails\"}",
    "{\"schemaVersion\":2,\"requestId\":\"secret with spaces\",\"operation\":\"qrLogin\"}" })
{
    try { WorkshopProtocol.Parse(Bytes(invalid)); throw new Exception("invalid auth accepted"); }
    catch (ProtocolException error) { Assert(error.Code == "LUA_STEAM_AUTH_PROTOCOL_INVALID", "fixed auth error"); }
}
Assert(WorkshopProtocol.ValidChallenge("https://s.team/q/1/1234"), "official challenge");
foreach (var url in new[] { "https://s.team.evil.test/q/1", "http://s.team/q/1", "https://s.team@evil.test/q/1", "https://s.team/q/1?token=no", "https://s.team:444/q/1", "https://s.team/other" })
    Assert(!WorkshopProtocol.ValidChallenge(url), "reject noncanonical challenge");
using (var frames = new MemoryStream())
{
    WorkshopProtocol.WriteFrame(frames, new { schemaVersion = 2, requestId = "qr-1", sequence = 1, kind = "challenge", challengeUrl = "https://s.team/q/1/1234" });
    var encoded = frames.ToArray();
    Assert(encoded[^1] == (byte)'\n' && encoded.Count(b => b == (byte)'\n') == 1, "bounded newline frame");
    Assert(!Encoding.UTF8.GetString(encoded).Contains("refreshToken"), "public frame excludes credential");
}
Console.WriteLine("PASS Workshop v2 parsing, credential separation, canonical QR host and bounded frames");
var loginDetails = WorkshopClient.CreateLogOnDetails("fixture", "fixture-not-a-real-token");
Assert(loginDetails.LoginID.HasValue && loginDetails.LoginID.Value > 0, "separate Steam login identity avoids address-derived client collision");
Assert(loginDetails.Username == "fixture" && loginDetails.ShouldRememberPassword, "account login details retained");
if (args.Contains("--live"))
{
    var live = new PicsClient().Fetch(new Request("live-pics-2067920", 2067920));
    Console.WriteLine($"LIVE source={live.Source} success={live.Success} appId={live.AppId} changeNumber={live.ChangeNumber} error={live.ErrorCode ?? "none"} rootFields={live.AppInfo?.Count ?? 0}");
    Assert(live.Success && live.AppInfo is { Count: > 0 }, "anonymous PICS live failure");
    Assert(live.AppInfo!.TryGetValue("common", out var liveCommon) && liveCommon is Dictionary<string, object?> info && info.ContainsKey("name"), "real name metadata");
}
