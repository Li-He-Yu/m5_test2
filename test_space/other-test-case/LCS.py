def lcs(s1: str, s2: str) -> str:
    """返回 s1 和 s2 的一個最長公共子序列（字符串形式）"""
    n, m = len(s1), len(s2)
    # dp[i][j] = 最長公共子序列長度，考慮 s1[:i], s2[:j]
    dp = [[0] * (m + 1) for _ in range(n + 1)]

    # 填表
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if s1[i - 1] == s2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = (
                    dp[i - 1][j] if dp[i - 1][j] >= dp[i][j - 1] else dp[i][j - 1]
                )

    # 回溯取得子序列
    i, j = n, m
    seq = []
    while i > 0 and j > 0:
        if s1[i - 1] == s2[j - 1]:
            seq.append(s1[i - 1])
            i -= 1
            j -= 1
        else:
            if dp[i - 1][j] >= dp[i][j - 1]:
                i -= 1
            else:
                j -= 1

    return "".join(reversed(seq))