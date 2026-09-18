using System.Diagnostics;
using SteamKit2;
using SteamKit2.Discovery;

namespace LuaSteamKit;

public sealed class PicsClient
{
    public static readonly TimeSpan OverallTimeout = TimeSpan.FromSeconds(35);

    private sealed class NoMachineIdentity : IMachineInfoProvider
    {
        public byte[]? GetMachineGuid() => null;
        public byte[]? GetMacAddress() => null;
        public byte[]? GetDiskId() => null;
    }

    public Response Fetch(Request request, CancellationToken cancellation = default)
    {
        var configuration = SteamConfiguration.Create(builder => builder
            .WithProtocolTypes(ProtocolTypes.WebSocket)
            .WithConnectionTimeout(TimeSpan.FromSeconds(10))
            .WithServerListProvider(new MemoryServerListProvider())
            .WithMachineInfoProvider(new NoMachineIdentity())
            .WithHttpClientFactory(_ => new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
                { Timeout = TimeSpan.FromSeconds(10) }));
        var client = new SteamClient(configuration);
        var manager = new CallbackManager(client);
        var user = client.GetHandler<SteamUser>()!;
        var apps = client.GetHandler<SteamApps>()!;
        var subscriptions = new List<IDisposable>();
        var loggedOn = false;
        var shuttingDown = false;
        Response? result = null;
        JobID? productJobId = null;
        SteamApps.PICSProductInfoCallback.PICSProductInfo? product = null;
        var timer = Stopwatch.StartNew();
        try
        {
            subscriptions.Add(manager.Subscribe<SteamClient.ConnectedCallback>(_ => user.LogOnAnonymous()));
            subscriptions.Add(manager.Subscribe<SteamClient.DisconnectedCallback>(_ =>
            {
                if (!shuttingDown && result is null) result = Response.Error(request.RequestId, request.AppId, "CM_DISCONNECTED");
            }));
            subscriptions.Add(manager.Subscribe<SteamUser.LoggedOnCallback>(callback =>
            {
                if (callback.Result != EResult.OK)
                {
                    result = Response.Error(request.RequestId, request.AppId, "ANONYMOUS_LOGON_REJECTED");
                    return;
                }
                loggedOn = true;
                // Zero access token requests public appinfo only. No license grants, game launch,
                // private-beta access, depot keys or account authentication are performed.
                var job = apps.PICSGetProductInfo(new SteamApps.PICSRequest(request.AppId), null, false);
                job.Timeout = TimeSpan.FromSeconds(20);
                productJobId = job.JobID;
            }));
            subscriptions.Add(manager.Subscribe<SteamUser.LoggedOffCallback>(_ =>
            {
                if (!shuttingDown && result is null) result = Response.Error(request.RequestId, request.AppId, "ANONYMOUS_LOGGED_OFF");
            }));
            subscriptions.Add(manager.Subscribe<SteamApps.PICSProductInfoCallback>(callback =>
            {
                if (productJobId is null || !callback.JobID.Equals(productJobId)) return;
                if (callback.UnknownApps.Contains(request.AppId))
                {
                    result = Response.Error(request.RequestId, request.AppId, "APPINFO_UNAVAILABLE");
                    return;
                }
                if (callback.Apps.TryGetValue(request.AppId, out var found)) product = found;
                if (callback.ResponsePending) return;
                if (product is null || product.ID != request.AppId) result = Response.Error(request.RequestId, request.AppId, "APPINFO_UNAVAILABLE");
                else if (product.MissingToken) result = Response.Error(request.RequestId, request.AppId, "APPINFO_REQUIRES_ACCESS_TOKEN");
                else if (product.KeyValues.Children.Count == 0) result = Response.Error(request.RequestId, request.AppId,
                    product.UseHttp ? "APPINFO_CM_BODY_UNAVAILABLE" : "APPINFO_EMPTY");
                else
                {
                    var data = Protocol.ConvertKeyValues(product.KeyValues);
                    if (data.TryGetValue("appid", out var appId) && appId?.ToString() != request.AppId.ToString(System.Globalization.CultureInfo.InvariantCulture))
                        result = Response.Error(request.RequestId, request.AppId, "APPINFO_ID_MISMATCH");
                    else result = new Response(1, request.RequestId, true, "steamKit", request.AppId, data, ChangeNumber: product.ChangeNumber);
                }
            }));
            client.Connect();
            // Keep pumping callbacks throughout login AND PICS; stopping after login loses replies.
            while (result is null && timer.Elapsed < OverallTimeout && !cancellation.IsCancellationRequested)
                manager.RunWaitCallbacks(TimeSpan.FromMilliseconds(100));
            return result ?? Response.Error(request.RequestId, request.AppId,
                cancellation.IsCancellationRequested ? "CANCELLED" : loggedOn ? "PICS_TIMEOUT" : "CM_TIMEOUT");
        }
        catch (ProtocolException error) { return Response.Error(request.RequestId, request.AppId, error.Code); }
        catch { return Response.Error(request.RequestId, request.AppId, "STEAMKIT_FAILURE"); }
        finally
        {
            shuttingDown = true;
            try { if (loggedOn) user.LogOff(); } catch { /* Disconnect is still required. */ }
            try { client.Disconnect(); } catch { /* Parent also owns a bounded process lifetime. */ }
            foreach (var subscription in subscriptions) subscription.Dispose();
        }
    }
}
