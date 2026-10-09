namespace FaroHQ.AspNetCore;

/// <summary>Captura manual, para erros tratados que mesmo assim você quer ver no FaroHQ.</summary>
public interface IFaroHQClient
{
    void CaptureException(Exception exception, IReadOnlyDictionary<string, string?>? context = null);

    void CaptureMessage(string message, IReadOnlyDictionary<string, string?>? context = null);
}
