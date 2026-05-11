Sub Main
    On Error GoTo AutomationError

    Dim SurferApp As Object
    Set SurferApp = CreateObject("Surfer.Application")
    SurferApp.Visible = False

    Dim InGrid As String
    Dim BoundaryFile As String
    Dim ColorFile As String
    Dim BlankedGrid As String
    Dim OutSrf As String

    InGrid = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\E-1_反演3_zW0\iteration_000_surfer.grd"
    BoundaryFile = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\E-1_反演3_zW0\iteration_000_boundary.bln"
    ColorFile = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\E-1_反演3_zW0\iteration_000_rainbow.clr"
    BlankedGrid = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\E-1_反演3_zW0\iteration_000_surfer_blanked.grd"
    OutSrf = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\E-1_反演3_zW0\iteration_000_surfer.srf"

    SurferApp.GridAssignNoData(InGrid:=InGrid, NoDataFile:=BoundaryFile, OutGrid:=BlankedGrid)

    Dim Plot As Object
    Set Plot = SurferApp.Documents.Add

    Dim MapFrame As Object
    Set MapFrame = Plot.Shapes.AddColorReliefMap(GridFileName:=BlankedGrid)

    Dim ColorLayer As Object
    Set ColorLayer = MapFrame.Overlays(1)
    ColorLayer.TerrainRepresentation = srfTerrainRepresentationColorOnly
    ColorLayer.ColorMap.LoadFile(FileName:=ColorFile)
    ColorLayer.ShowColorScale = True
    ColorLayer.MissingDataColorRGBA.Color = srfColorWhite
    ColorLayer.MissingDataColorRGBA.Opacity = 0

    Plot.SaveAs(OutSrf)
    Plot.Close
    SurferApp.Quit
    Exit Sub

AutomationError:
    MsgBox "Surfer SRF export failed: " & Err.Description & vbCrLf & vbCrLf & _
        "If the message says server could not be found, Surfer Automation is not registered." & vbCrLf & _
        "Run Surfer/Scripter as administrator or run Surfer.exe /register, then try again.", vbCritical
End Sub
