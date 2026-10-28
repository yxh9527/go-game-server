package gogame

import (
	"fmt"

	"gorm.io/gorm"
)

// Register in SeedIfEmpty after seedSgayIfMissing. Only missing identities are
// inserted; existing operator configuration and balances remain untouched.
func seedMahjongIfMissing(m *gorm.DB, now int64) {
	tiers := []struct {
		id, roomType, mode, ante, carry int64
		class                           int32
	}{
		{2601, 26, 0, 10, 2000, 2}, {2602, 26, 0, 50, 10000, 2}, {2603, 26, 0, 200, 50000, 4},
		{2604, 26, 1, 10, 2000, 2}, {2605, 26, 1, 50, 10000, 2}, {2606, 26, 1, 200, 50000, 4},
		{2801, 28, 2, 10, 2000, 2}, {2802, 28, 2, 50, 10000, 2}, {2803, 28, 2, 200, 50000, 2},
		{2804, 28, 4, 10, 2000, 2}, {2805, 28, 4, 50, 10000, 2}, {2806, 28, 4, 200, 50000, 2},
		{3001, 30, 0, 10, 2000, 2}, {3002, 30, 1, 10, 2000, 2}, {3003, 30, 0, 50, 10000, 2},
		{3004, 30, 1, 50, 10000, 2}, {3005, 30, 0, 20, 4000, 4}, {3006, 30, 1, 20, 4000, 4},
	}
	for index, tier := range tiers {
		var count int64
		if err := m.Model(&RoomConfig{}).Where("room_type = ? AND game_room_config_id = ?", tier.roomType, tier.id).Count(&count).Error; err != nil {
			panic(err)
		}
		if count > 0 {
			continue
		}
		family := map[int64]string{26: "jsmj", 28: "csmj", 30: "hzxl"}[tier.roomType]
		label := map[int64]string{26: "极速麻将", 28: "长沙麻将", 30: "红中血流"}[tier.roomType]
		capacity := int64(4)
		if tier.roomType == 28 {
			capacity = tier.mode
		} else if tier.mode == 1 {
			capacity = 2
		}
		name := fmt.Sprintf("%s %d人 底注%.2f", label, capacity, float64(tier.ante)/100)
		params := map[string]any{
			"diFen": tier.ante, "ante": tier.ante, "carryMin": tier.carry,
			"carryMax": -1, "carryDefault": 0, "opTime": 10, "betTime": 0,
			"gameStartNum": capacity, "maxPeople": capacity, "gameName": name,
			"randomSit": true, "observed": true, "banTalk": true, "openTaxNoLimit": true,
			"taxType": 2, "taxPercent": 500,
		}
		if tier.roomType == 26 && capacity == 2 {
			params["cardNum"] = 52
		} else {
			params["cardNum"] = 0
		}
		row := &RoomConfig{
			GameType: int32(tier.roomType), SubGameType: 0, RoomType: int32(tier.roomType),
			GameRoomConfigId: tier.id, PlayMode: int32(tier.mode), CarryMin: tier.carry,
			Category: "normal", Name: name, State: 1, SortIndex: int32(2600 + index),
			CreateTime: now, UpdateTime: now,
			Payload: mustJSON(map[string]any{
				"roomType": tier.roomType, "gameRoomConfigId": tier.id, "playMode": tier.mode,
				"ante": tier.ante, "diFen": tier.ante, "carryMin": tier.carry, "carryMax": -1,
				"roomClassification": tier.class, "gameName": name, "maxPeople": capacity,
				"gameStartNum": capacity, "observed": true, "randomSit": true, "allowCarryOut": true,
				"taxType": 2, "taxPercent": 500, family + "Params": params,
				"key": fmt.Sprintf("%d/%d/%d/%d/%d", tier.roomType, tier.mode, tier.ante, tier.class, tier.carry),
			}),
		}
		if err := m.Create(row).Error; err != nil {
			panic(err)
		}
	}
}
