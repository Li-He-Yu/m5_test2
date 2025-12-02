def function2(nums: List[int]) -> List[int]:
    result = []
    for i in range(len(nums)):
        count = 0
        for j in range(len(nums)):
            if nums[j] < nums[i]:
                count += 1
        result.append(count)
    return result

if __name__ == "__main__":
    arr = list(map(int, input().split(','))) # input array
    ans = function2(arr)