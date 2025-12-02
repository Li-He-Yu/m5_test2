text1_length = 10
text1, text2 = "", ""
dp = [10][10]
i, j = 10, 10

for i in range(1, text1_length + 1):
	if text1[i - 1] == text2[j - 1]:
		dp[i][j] = 1 + dp[i - 1][j - 1]
		if dp[i][j] > max_length:
			end_pos = i
			max_length = dp[i][j]