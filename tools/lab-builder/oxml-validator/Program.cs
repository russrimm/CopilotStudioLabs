using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

// Validates .pptx/.docx/.xlsx files against the Open XML SDK schemas and prints
// one JSON document per input file on stdout:
//   { "file": "...", "opened": true, "errorCount": 0, "errors": [ { part, path, id, type, description } ] }
// Exit code is 0 when every file opened and has zero errors, otherwise 1.

var files = args.Where(a => !a.StartsWith("--")).ToList();
if (files.Count == 0)
{
    Console.Error.WriteLine("usage: OxmlValidator <file.pptx|file.docx|file.xlsx>...");
    return 2;
}

const int MaxErrorsPerFile = 200;
var jsonOptions = new JsonSerializerOptions { WriteIndented = false };
var failed = false;

foreach (var file in files)
{
    var errors = new List<Dictionary<string, string>>();
    var errorCount = 0;
    var opened = false;
    string? openError = null;

    try
    {
        var ext = Path.GetExtension(file).ToLowerInvariant();
        var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
        using OpenXmlPackage doc = ext switch
        {
            ".pptx" => PresentationDocument.Open(file, false),
            ".docx" => WordprocessingDocument.Open(file, false),
            ".xlsx" => SpreadsheetDocument.Open(file, false),
            _ => throw new InvalidOperationException($"Unsupported extension '{ext}'."),
        };
        opened = true;
        foreach (var e in validator.Validate(doc))
        {
            errorCount++;
            if (errors.Count >= MaxErrorsPerFile) continue;
            errors.Add(new Dictionary<string, string>
            {
                ["part"] = e.Part?.Uri.ToString() ?? "",
                ["path"] = e.Path?.XPath ?? "",
                ["id"] = e.Id ?? "",
                ["type"] = e.ErrorType.ToString(),
                ["description"] = e.Description ?? "",
            });
        }
    }
    catch (Exception ex)
    {
        openError = $"{ex.GetType().Name}: {ex.Message}";
    }

    if (!opened || errorCount > 0) failed = true;
    Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["file"] = file,
        ["opened"] = opened,
        ["openError"] = openError,
        ["errorCount"] = errorCount,
        ["errors"] = errors,
    }, jsonOptions));
}

return failed ? 1 : 0;
