ERT 二维反演 - Surfer 出图说明
================================

本目录包含以下与 Surfer 相关的文件：

  iteration_012_surfer.grd                 反演结果 ASCII 网格（电阻率）
  iteration_012_boundary.bln             反演域外轮廓（用于裁剪）
  iteration_012_rainbow.clr                推荐色标
  iteration_012_surfer_export.bas               Surfer Scripter 自动出图宏（VBA）
  resistivity.vtk             原始 VTK 网格（可在 ParaView / VisIt 直接打开）

【一键出图（推荐）】
  1. 启动 Golden Software Surfer（任意支持 Scripter 的版本均可）。
  2. 打开 Scripter（菜单：工具 → Scripter，或直接双击 iteration_012_surfer_export.bas）。
  3. 在 Scripter 中按 F5（或菜单 Script → Run）执行宏。
  4. 几秒后会在本目录生成 iteration_012_surfer.srf（工程文件）和
     iteration_012_surfer_blanked.grd（按外轮廓裁剪后的网格）。
  5. 双击 iteration_012_surfer.srf 即可查看带边界裁剪的彩色等值图。

【手动操作】
  - 新建 → 网格图 → 选择 iteration_012_surfer.grd
  - 网格 → 数据空白化（GridAssignNoData 或 GridBlank）→
    选择 iteration_012_boundary.bln 作为裁剪边界
  - 颜色映射加载 iteration_012_rainbow.clr

【无 Surfer 时的替代】
  使用 ParaView / VisIt 直接打开 resistivity.vtk，
  或在云端结果页查看自动生成的剖面图预览。
