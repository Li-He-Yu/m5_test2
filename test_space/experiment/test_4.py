def function4(nums1: List[int], nums2: List[int]) -> List[int]:
    result = []
    for i in range(len(nums1)):
        for j in range(len(nums2)):
            if nums1[i] == nums2[j] and nums1[i] not in result:
                result.append(nums1[i])
    return result

if __name__ == "__main__":
    arr1 = list(map(int, input().split(','))) # input array1
    arr2 = list(map(int, input().split(','))) # input array2
    ans = function4(arr1, arr2)