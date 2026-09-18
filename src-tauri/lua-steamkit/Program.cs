using System.Text;

namespace LuaSteamKit;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Response response;
        Request? request = null;
        try
        {
            if (args.Length != 0) throw new ProtocolException("CLI_ARGUMENTS_NOT_ALLOWED");
            using var inputTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var input = await Protocol.ReadRequestAsync(Console.OpenStandardInput(), inputTimeout.Token, WorkshopProtocol.MaximumFrameBytes).ConfigureAwait(false);
            WorkshopRequest? workshop = null;
            try
            {
                if (WorkshopProtocol.IsVersionTwo(input)) workshop = WorkshopProtocol.Parse(input);
                else request = Protocol.Parse(input);
            }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(input); }
            if (workshop is not null) return await new WorkshopClient().RunAsync(workshop, Console.OpenStandardOutput()).ConfigureAwait(false);
            if (request is null) throw new ProtocolException("INVALID_REQUEST");
            response = new PicsClient().Fetch(request);
        }
        catch (OperationCanceledException) { response = Response.Error(request?.RequestId ?? "", request?.AppId ?? 0, "INPUT_TIMEOUT"); }
        catch (ProtocolException error) { response = Response.Error(request?.RequestId ?? "", request?.AppId ?? 0, error.Code); }
        catch { response = Response.Error(request?.RequestId ?? "", request?.AppId ?? 0, "SIDECAR_FAILURE"); }
        try
        {
            var output = Console.OpenStandardOutput();
            var encoded = Protocol.EncodeOutcome(response);
            await output.WriteAsync(encoded.Bytes).ConfigureAwait(false);
            await output.WriteAsync(new byte[] { (byte)'\n' }).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
            return encoded.ExitCode;
        }
        catch { return 3; }
    }
}
