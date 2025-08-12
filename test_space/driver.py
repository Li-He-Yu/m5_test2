###########################
#  import my_pyflowchart  #
###########################

# senior_project/test_space/driver.py
import sys, importlib, inspect
from pathlib import Path

## __file__ 取得目前位置，resolve 處理路徑，再取得 Parent (目前所在的 folder)
## here.parents[0] = one level up (the project root, e.g. .../your_project)
## here.parents[1] = two levels up (e.g. the parent of your_project)
here = Path(__file__).resolve().parent
project_root = here.parent                                  # .../senior_project
# 讓 Python 找到你專案裡的 pyflowchart
pyflowchart_root = project_root / 'm5_test2' / 'my_pyflowchart'
sys.path.insert(0, str(pyflowchart_root))

# sanity check (optional, but helpful)
# print("PYFLOWCHART_ROOT =", pyflowchart_root)
# assert (pyflowchart_root / 'pyflowchart').is_dir()

try:
    from pyflowchart import Flowchart
    from pyflowchart.__main__ import output as fc_output
    from pyflowchart.__main__ import main as m_main
except ImportError:
    # depending on the fork, Flowchart may live in .main or .flowchart
    try:
        from pyflowchart.main import Flowchart
        from pyflowchart.__main__ import output as fc_output
        from pyflowchart.__main__ import main as m_main
    except ImportError:
        from pyflowchart.flowchart import Flowchart  # last resort
        from pyflowchart.__main__ import output as fc_output
        from pyflowchart.__main__ import main as m_main




###########################
#  import code to parse   #
###########################

MODULE_NAME = 'test3'
TARGET_FUNC = 'foo'

src_file = here / f"{MODULE_NAME}.py"
out_path = here / f"{MODULE_NAME}_{TARGET_FUNC}.html"

with open(src_file, "rb") as code_file:  # IMPORTANT: binary mode ('rb')
    m_main(
        code_file=code_file,
        field=TARGET_FUNC,            # empty → parse whole module
        inner=True,          # parse the bodies of top-level defs
        output_file=str(out_path),
        simplify=False,      # set True if you want one-line if/loop simplified
        conds_align=False    # set True to align consecutive ifs
    )