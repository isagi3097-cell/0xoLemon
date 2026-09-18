using SteamKit2;
using SteamKit2.Authentication;
using SteamKit2.Discovery;
using SteamKit2.Internal;

namespace LuaSteamKit;

public sealed class WorkshopClient
{
    public static SteamUser.LogOnDetails CreateLogOnDetails(string name, string token) => new()
    {
        Username = name, AccessToken = token, ShouldRememberPassword = true,
        // SteamKit's address-derived default can collide with the official client
        // on the same IP. Give this short-lived Lua session its own login identity.
        LoginID = (uint)System.Security.Cryptography.RandomNumberGenerator.GetInt32(1, int.MaxValue)
    };
    private sealed class NoMachineIdentity : IMachineInfoProvider
    {
        public byte[]? GetMachineGuid() => null;
        public byte[]? GetMacAddress() => null;
        public byte[]? GetDiskId() => null;
    }

    public async Task<int> RunAsync(WorkshopRequest request, Stream output)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(request.Operation == "qrLogin" ? 180 : 40));
        var cancellation = timeout.Token;
        var client = new SteamClient(SteamConfiguration.Create(builder => builder
            .WithProtocolTypes(ProtocolTypes.WebSocket).WithConnectionTimeout(TimeSpan.FromSeconds(10))
            .WithServerListProvider(new MemoryServerListProvider()).WithMachineInfoProvider(new NoMachineIdentity())
            .WithHttpClientFactory(_ => new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(10) })));
        var callbacks = new CallbackManager(client);
        var user = client.GetHandler<SteamUser>()!;
        var connected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loggedOn = new TaskCompletionSource<SteamUser.LoggedOnCallback>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var onConnected = callbacks.Subscribe<SteamClient.ConnectedCallback>(_ => connected.TrySetResult());
        using var onDisconnected = callbacks.Subscribe<SteamClient.DisconnectedCallback>(_ => timeout.Cancel());
        using var onLoggedOn = callbacks.Subscribe<SteamUser.LoggedOnCallback>(result => loggedOn.TrySetResult(result));
        using var pumpStop = new CancellationTokenSource();
        var pump = Task.Run(() => { while (!pumpStop.IsCancellationRequested) callbacks.RunWaitCallbacks(TimeSpan.FromMilliseconds(100)); });
        uint sequence = 0;
        try
        {
            client.Connect();
            await connected.Task.WaitAsync(TimeSpan.FromSeconds(20), cancellation).ConfigureAwait(false);
            string name;
            string token;
            if (request.Operation == "qrLogin")
            {
                var auth = await client.Authentication.BeginAuthSessionViaQRAsync(new AuthSessionDetails
                {
                    DeviceFriendlyName = "0xoLemon · Lua Workshop", IsPersistentSession = true,
                    PlatformType = EAuthTokenPlatformType.k_EAuthTokenPlatformType_SteamClient
                }).WaitAsync(cancellation).ConfigureAwait(false);
                var challengeCount = 0;
                void Challenge()
                {
                    if (++challengeCount > 24 || !WorkshopProtocol.ValidChallenge(auth.ChallengeURL)) throw new ProtocolException("LUA_STEAM_AUTH_CHALLENGE_INVALID");
                    WorkshopProtocol.WriteFrame(output, new { schemaVersion = 2, requestId = request.RequestId, sequence = ++sequence, kind = "challenge", challengeUrl = auth.ChallengeURL });
                }
                auth.ChallengeURLChanged = Challenge;
                Challenge();
                var credentials = await auth.PollingWaitForResultAsync(cancellation).ConfigureAwait(false);
                name = credentials.AccountName;
                token = credentials.RefreshToken;
                auth.ChallengeURLChanged = null;
            }
            else { name = request.AccountName!; token = request.RefreshToken!; }
            user.LogOn(CreateLogOnDetails(name, token));
            var login = await loggedOn.Task.WaitAsync(TimeSpan.FromSeconds(20), cancellation).ConfigureAwait(false);
            if (login.Result != EResult.OK || client.SteamID is null) throw new ProtocolException("LUA_STEAM_AUTH_REJECTED");
            var steamId = client.SteamID.ConvertToUInt64();
            if (request.Operation == "qrLogin")
            {
                // This frame is consumed only by Rust and committed directly to DPAPI.
                WorkshopProtocol.WriteFrame(output, new { schemaVersion = 2, requestId = request.RequestId, sequence = ++sequence, kind = "credential", accountName = name, refreshToken = token, steamId = steamId.ToString() });
            }
            else
            {
                if (steamId != request.SteamId) throw new ProtocolException("LUA_STEAM_AUTH_ACCOUNT_CHANGED");
                var service = client.GetHandler<SteamUnifiedMessages>()!.CreateService<PublishedFile>();
                var query = new CPublishedFile_GetDetails_Request { appid = request.AppId, includechildren = false };
                query.publishedfileids.Add(request.ItemId);
                var job = service.GetDetails(query);
                job.Timeout = TimeSpan.FromSeconds(15);
                var response = await job;
                if (response.Result != EResult.OK || response.Body.publishedfiledetails.Count != 1) throw new ProtocolException("LUA_WORKSHOP_ACCESS_DENIED");
                var item = response.Body.publishedfiledetails[0];
                if (item.result != (uint)EResult.OK || item.publishedfileid != request.ItemId || item.consumer_appid != request.AppId) throw new ProtocolException("LUA_WORKSHOP_ACCESS_DENIED");
                WorkshopProtocol.WriteFrame(output, new { schemaVersion = 2, requestId = request.RequestId, sequence = ++sequence, kind = "details", steamId = steamId.ToString(),
                    appid = request.AppId, itemId = request.ItemId.ToString(), title = new string(item.title.Where(c => !char.IsControl(c)).Take(256).ToArray()),
                    sizeBytes = item.file_size, updatedAt = item.time_updated, contentUrl = item.file_url, manifestId = item.hcontent_file.ToString(), fileType = item.file_type });
            }
            return 0;
        }
        catch (Exception error)
        {
            // Never serialize SDK exception messages: they can contain request/token details.
            var code = error is ProtocolException protocol ? protocol.Code : error is OperationCanceledException or TimeoutException ? "LUA_STEAM_AUTH_TIMEOUT" : "LUA_STEAM_AUTH_FAILED";
            WorkshopProtocol.WriteFrame(output, new { schemaVersion = 2, requestId = request.RequestId, sequence = ++sequence, kind = "error", errorCode = code });
            return 2;
        }
        finally
        {
            try { user.LogOff(); client.Disconnect(); } catch { /* Parent enforces bounded lifetime too. */ }
            pumpStop.Cancel();
            await pump.ConfigureAwait(false);
        }
    }
}
