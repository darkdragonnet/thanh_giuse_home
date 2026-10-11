import { RawCloudFace } from '@thanh-giuse/shared-types';

export function generate108MockFaces(): RawCloudFace[] {
  const faces: RawCloudFace[] = [];

  // 1. Thêm Sức 1A (25 em)
  for (let i = 1; i <= 25; i++) {
    const idStr = String(i).padStart(2, '0');
    faces.push({
      personID: `188972444008101${idStr}`,
      name: `Thiếu Nhi TS1A ${idStr}`,
      aliasID: `TN_Themsuc1a_${idStr}`,
      file: `https://static.hanet.ai/face/employee/ts1a_${idStr}.jpg`,
      title: 'Học sinh',
    });
  }

  // 2. Thêm Sức 1B (20 em)
  for (let i = 1; i <= 20; i++) {
    const idStr = String(i).padStart(2, '0');
    faces.push({
      personID: `188972444008102${idStr}`,
      name: `Thiếu Nhi TS1B ${idStr}`,
      aliasID: `TN_Themsuc1b_${idStr}`,
      file: `https://static.hanet.ai/face/employee/ts1b_${idStr}.jpg`,
      title: 'Học sinh',
    });
  }

  // 3. Rước Lễ 1A (33 em)
  for (let i = 1; i <= 33; i++) {
    const idStr = String(i).padStart(2, '0');
    faces.push({
      personID: `188972444008103${idStr}`,
      name: `Thiếu Nhi RL1A ${idStr}`,
      aliasID: `TN_Rucle1a_${idStr}`,
      file: `https://static.hanet.ai/face/employee/rl1a_${idStr}.jpg`,
      title: 'Học sinh',
    });
  }

  // 4. Ban Giáo Lý Viên (12 người)
  for (let i = 1; i <= 12; i++) {
    const idStr = String(i).padStart(2, '0');
    faces.push({
      personID: `188972444008104${idStr}`,
      name: `Giáo Lý Viên ${idStr}`,
      aliasID: `TN_GLV_${idStr}`,
      file: `https://static.hanet.ai/face/employee/glv_${idStr}.jpg`,
      title: 'Giáo Lý Viên',
    });
  }

  // 5. Lêgiô - DMHCCC (14 hội viên)
  for (let i = 1; i <= 14; i++) {
    const idStr = String(i).padStart(2, '0');
    faces.push({
      personID: `188972444008105${idStr}`,
      name: `Hội Viên DMHCCC ${idStr}`,
      aliasID: `LG_DMHCCC_${idStr}`,
      file: `https://static.hanet.ai/face/employee/dmhccc_${idStr}.jpg`,
      title: 'Hội viên',
    });
  }

  // 6. 4 Bản ghi lỗi dị biệt (UNPARSED)
  faces.push(
    {
      personID: '18897244400819901',
      name: 'Thừa gạch dưới TS',
      aliasID: 'TN_Themsuc1a_01_extra',
      file: 'https://static.hanet.ai/face/employee/err1.jpg',
      title: 'Lỗi 4 phần',
    },
    {
      personID: '18897244400819902',
      name: 'GLV Trưởng Đoàn',
      aliasID: 'TN_GLV_Truong_Doan',
      file: 'https://static.hanet.ai/face/employee/err2.jpg',
      title: 'Lỗi 4 phần',
    },
    {
      personID: '18897244400819903',
      name: 'Thiếu định danh LG',
      aliasID: 'LG_DMHCCC',
      file: 'https://static.hanet.ai/face/employee/err3.jpg',
      title: 'Lỗi 2 phần',
    },
    {
      personID: '18897244400819904',
      name: 'Mã số thuần túy',
      aliasID: '123456789',
      file: 'https://static.hanet.ai/face/employee/err4.jpg',
      title: 'Lỗi không dấu gạch',
    }
  );

  return faces; // Tổng cộng: 25 + 20 + 33 + 12 + 14 + 4 = 108 Face IDs
}
