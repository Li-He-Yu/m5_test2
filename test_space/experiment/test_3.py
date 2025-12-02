def function3(nums: List[int]) -> List[int]:
    missing = []
    n = len(nums)
    for x in range(1, n + 1):
        found = False
        for j in range(n):
            if nums[j] == x:
                found = True
                break
        if not found:
            missing.append(x)
    return missing

if __name__ == "__main__":
    arr = list(map(int, input().split(','))) # input array
    ans = function3(arr)