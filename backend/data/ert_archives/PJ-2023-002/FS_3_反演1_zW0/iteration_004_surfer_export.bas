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

    InGrid = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\FS_3_反演1_zW0\iteration_004_surfer.grd"
    BoundaryFile = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\FS_3_反演1_zW0\iteration_004_boundary.bln"
    ColorFile = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\FS_3_反演1_zW0\iteration_004_rainbow.clr"
    BlankedGrid = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\FS_3_反演1_zW0\iteration_004_surfer_blanked.grd"
    OutSrf = "F:\test\trae code\geoyun1\backend\data\ert_archives\PJ-2023-002\FS_3_反演1_zW0\iteration_004_surfer.srf"

    ' Try GridAssignNoData first (Surfer 16+), fallback to GridBlank (Surfer 15-)
    On Error Resume Next
    SurferApp.GridAssignNoData InGrid, BoundaryFile, BlankedGrid
    If Err.Number <> 0 Then
        Err.Clear
        SurferApp.GridBlank InGrid, BoundaryFile, BlankedGrid
    End If
    On Error GoTo AutomationError

    Dim Plot As Object
    Set Plot = SurferApp.Documents.Add

    Dim MapFrame As Object
    Set MapFrame = Plot.Shapes.AddColorReliefMap(BlankedGrid)

    Dim ColorLayer As Object
    Set ColorLayer = MapFrame.Overlays(1)
    
    ' 2 = srfTerrainRepresentationColorOnly
    ColorLayer.TerrainRepresentation = 2
    ColorLayer.ColorMap.LoadFile ColorFile
    ColorLayer.ShowColorScale = True
    
    ' Try newer RGBA first, fallback to older MissingDataColor
    On Error Resume Next
    ' 15 = srfColorWhite
    ColorLayer.MissingDataColorRGBA.Color = 15
    ColorLayer.MissingDataColorRGBA.Opacity = 0
    If Err.Number <> 0 Then
        Err.Clear
        ColorLayer.MissingDataColor = 15
    End If
    On Error GoTo AutomationError

    Plot.SaveAs OutSrf
    ' 2 = srfSaveChangesNo
    Plot.Close 2
    SurferApp.Quit
    Exit Sub

AutomationError:
    ' We suppress MsgBox so it doesn't block the backend process, just quit
    SurferApp.Quit
End Sub
