def function1(nums: List[int], target: int) -> List[int]:
    n = len(nums)
    for i in range(n - 1):
        for j in range(i + 1, n):
            if nums[i] + nums[j] == target:
                return [i, j]
    return []

if __name__ == "__main__":
    num = int(input())
    arr = list(map(int, input().split(','))) # input array
    ans = function1(arr, num)