using FaroHQ.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddFaroHQ(builder.Configuration);

var app = builder.Build();
app.UseFaroHQ();

app.MapGet("/", () => "FaroHQ.Sample no ar. Teste: /pedidos/42/fechar, /log-erro, /captura-manual");

// Exceção não tratada → capturada pelo middleware (com path e método)
app.MapPost("/pedidos/{id:int}/fechar", (int id) => new PedidoService().Fechar(id));
app.MapGet("/pedidos/{id:int}/fechar", (int id) => new PedidoService().Fechar(id));

// Erro só logado → capturado pelo logger
app.MapGet("/log-erro", (ILogger<Program> logger) =>
{
    logger.LogInformation("Importando planilha de preços (linha {Linha})", 17);
    logger.LogWarning("Coluna 'preço' vazia em 3 linhas");
    try
    {
        int.Parse("não é número");
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Falha ao importar planilha de preços");
    }
    return "Erro logado (veja no FaroHQ)";
});

// Erro tratado, enviado de propósito
app.MapGet("/captura-manual", (IFaroHQClient faro) =>
{
    faro.CaptureException(new InvalidOperationException("Estoque negativo para o SKU 123"),
        new Dictionary<string, string?> { ["sku"] = "123" });
    return "Enviado manualmente";
});

app.Run();

class PedidoService
{
    public decimal Fechar(int id)
    {
        Carrinho? carrinho = BuscarCarrinho(id);
        return carrinho!.Itens.Sum(i => i.Preco);
    }

    private static Carrinho? BuscarCarrinho(int id) => null;
}

record Carrinho(List<Item> Itens);

record Item(decimal Preco);
